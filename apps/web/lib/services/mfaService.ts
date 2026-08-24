import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getIdentityClient, withPlatformAuditContext } from "@noahark/db";
import {
  generateTotpSecret,
  buildProvisioningUri,
  verifyTotp,
  verifyTotpWithCounter,
  encryptMfaSecret,
  decryptMfaSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyPassword,
} from "@noahark/auth";
import {
  ForbiddenError,
  RateLimitedError,
  UnauthenticatedError,
  ValidationError,
} from "@noahark/core";
import { loadEnv } from "@noahark/config";
import { AUDIT_ACTIONS } from "@noahark/audit";
import { writeAuditEvent } from "./auditService";
import {
  isMfaRateLimited,
  recordMfaFailedAttempt,
  clearMfaAttempts,
} from "@/lib/rateLimiter";

/**
 * F-3B (Phase 1B): TOTP MFA. See packages/auth's totp.ts / mfaSecretCrypto.ts
 * / recoveryCodes.ts for the underlying primitives (RFC 6238 TOTP verified
 * against RFC 4226 test vectors; AES-256-GCM secret encryption keyed off
 * AUTH_SECRET; single-use hashed recovery codes).
 *
 * Enrolment is two-step (enroll → confirm) so a secret is never activated
 * without proving the user's authenticator app actually has it — an
 * unconfirmed MfaCredential (confirmedAt IS NULL) never gates sign-in.
 */

const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_IDENTIFIER_PREFIX = "mfa-challenge:";

function authSecret(): string {
  return loadEnv().AUTH_SECRET;
}

export interface EnrollMfaResult {
  provisioningUri: string;
  secret: string; // shown once, for manual entry if the user cannot scan a QR code
}

export async function enrollMfa(userId: string): Promise<EnrollMfaResult> {
  const db = getIdentityClient();
  const user = await db.user.findUnique({
    where: { id: userId },
    include: { mfaCredential: true },
  });
  if (!user) throw new UnauthenticatedError();
  if (user.mfaCredential?.confirmedAt) {
    throw new ValidationError("MFA is already enabled — disable it before re-enrolling");
  }

  const secret = generateTotpSecret();
  const secretEncrypted = encryptMfaSecret(secret, authSecret());

  await db.mfaCredential.upsert({
    where: { userId },
    create: { userId, secretEncrypted },
    update: { secretEncrypted, confirmedAt: null },
  });

  return { provisioningUri: buildProvisioningUri(secret, user.email), secret };
}

export const ConfirmMfaEnrollmentSchema = z.object({ code: z.string().length(6) });

export async function confirmMfaEnrollment(
  userId: string,
  code: string,
): Promise<{ recoveryCodes: string[] }> {
  const db = getIdentityClient();
  const credential = await db.mfaCredential.findUnique({ where: { userId } });
  if (!credential || credential.confirmedAt) {
    throw new ValidationError("No pending MFA enrolment found");
  }

  const secret = decryptMfaSecret(credential.secretEncrypted, authSecret());
  if (!verifyTotp(secret, code)) {
    throw new ValidationError("Invalid verification code");
  }

  const recoveryCodes = generateRecoveryCodes();
  await db.$transaction([
    db.mfaCredential.update({
      where: { id: credential.id },
      data: { confirmedAt: new Date() },
    }),
    db.mfaRecoveryCode.deleteMany({ where: { mfaCredentialId: credential.id } }),
    db.mfaRecoveryCode.createMany({
      data: recoveryCodes.map((code) => ({
        mfaCredentialId: credential.id,
        codeHash: hashRecoveryCode(code),
      })),
    }),
  ]);

  await withPlatformAuditContext((tx) =>
    writeAuditEvent(tx, {
      tenantId: null,
      actorUserId: userId,
      actorType: "USER",
      action: AUDIT_ACTIONS.MFA_ENROLLED,
      entityType: "user",
      entityId: userId,
      outcome: "SUCCESS",
      // Never the secret or recovery codes themselves — sanitizeForAudit
      // would redact them anyway (F-29's denylist), but this call site
      // never even constructs an object containing them.
    }),
  );

  return { recoveryCodes };
}

/** Requires re-authentication (current password) — disabling MFA is a
 * security-sensitive action, not something a hijacked session alone should
 * be able to do. */
export const DisableMfaSchema = z.object({ password: z.string().min(1) });

export async function disableMfa(userId: string, password: string): Promise<void> {
  const db = getIdentityClient();
  const user = await db.user.findUnique({
    where: { id: userId },
    include: { credential: true },
  });
  if (!user?.credential) throw new UnauthenticatedError();
  if (!(await verifyPassword(user.credential.passwordHash, password))) {
    throw new ForbiddenError("Incorrect password");
  }

  await db.mfaCredential.deleteMany({ where: { userId } }); // cascades to recovery codes

  await withPlatformAuditContext((tx) =>
    writeAuditEvent(tx, {
      tenantId: null,
      actorUserId: userId,
      actorType: "USER",
      action: AUDIT_ACTIONS.MFA_DISABLED,
      entityType: "user",
      entityId: userId,
      outcome: "SUCCESS",
    }),
  );
}

export async function hasMfaEnabled(userId: string): Promise<boolean> {
  const db = getIdentityClient();
  const credential = await db.mfaCredential.findUnique({ where: { userId } });
  return Boolean(credential?.confirmedAt);
}

function hashChallengeToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Issued by the sign-in route after password verification succeeds for a
 * user with MFA enabled — a narrow, short-lived (5 min) proof that "this
 * caller already presented the correct password for this user", exchanged
 * for a session only after a valid TOTP/recovery code. Reuses the
 * VerificationToken table (same as email verification/password-reset would)
 * rather than a new one. */
export async function issueMfaChallengeToken(userId: string): Promise<string> {
  const db = getIdentityClient();
  const identifier = `${CHALLENGE_IDENTIFIER_PREFIX}${userId}`;
  await db.verificationToken.deleteMany({ where: { identifier } });
  const rawToken = randomBytes(32).toString("base64url");
  await db.verificationToken.create({
    data: {
      identifier,
      token: hashChallengeToken(rawToken),
      expires: new Date(Date.now() + MFA_CHALLENGE_TTL_MS),
    },
  });
  return rawToken;
}

export const VerifyMfaChallengeSchema = z.object({
  challengeToken: z.string().min(1),
  code: z.string().min(1),
});

/**
 * Verifies the challenge token AND the submitted code (TOTP or a
 * single-use recovery code), returning the userId to create a session for.
 * The challenge token is consumed (deleted) as soon as it is found to be a
 * real, unexpired token — a failed MFA attempt does not get unlimited
 * retries against the same password-verification proof.
 *
 * N-1 (Phase 1D): rate-limited on two independent axes, checked BEFORE
 * any code is verified — `ipKey` alone (no account known yet) as soon as
 * this function is entered, and `userId` (once resolved from the token)
 * before the token is even deleted. This closes the gap the finding
 * described: a fresh challenge token issued after re-submitting the
 * correct password does NOT reset the limiter, because the account-level
 * counter is keyed by userId, not by the token — see
 * `lib/rateLimiter.ts`'s `isMfaRateLimited`/`recordMfaFailedAttempt`. Every
 * terminal failure path below (unknown token, expired token, unconfirmed
 * credential, wrong code, a REPLAYED — already-used — TOTP counter) records
 * a failed attempt; a successful verification clears the account counter
 * (`clearMfaAttempts` — a real reset, unlike the password limiter's
 * deliberate no-op; see that function's own doc comment for why resetting
 * is safe here specifically).
 */
export async function verifyMfaChallenge(
  rawChallengeToken: string,
  submittedCode: string,
  ipKey: string | null = null,
): Promise<{ userId: string }> {
  const db = getIdentityClient();

  // No account resolved yet — IP-only check, so even a completely blind
  // flood of garbage challenge tokens/codes is still throttled.
  if (await isMfaRateLimited(null, ipKey)) {
    throw new RateLimitedError("Too many MFA attempts — try again later");
  }

  const tokenHash = hashChallengeToken(rawChallengeToken);
  const record = await db.verificationToken.findUnique({ where: { token: tokenHash } });

  if (!record || !record.identifier.startsWith(CHALLENGE_IDENTIFIER_PREFIX)) {
    // No resolvable account — nothing to charge but the IP dimension.
    await recordMfaFailedAttempt(null, ipKey);
    throw new UnauthenticatedError("Invalid or expired MFA challenge");
  }

  const userId = record.identifier.slice(CHALLENGE_IDENTIFIER_PREFIX.length);

  // Re-check now that a real account is known — a caller cannot bypass an
  // already-locked account's limit merely by holding a not-yet-expired
  // token; the token is deliberately left untouched here (not consumed)
  // so a legitimate user who was rate-limited by their own mistakes can
  // still use the SAME token once the window lapses, without needing an
  // entirely new sign-in.
  if (await isMfaRateLimited(userId, ipKey)) {
    throw new RateLimitedError("Too many MFA attempts — try again later");
  }

  if (record.expires < new Date()) {
    await db.verificationToken.deleteMany({ where: { token: tokenHash } });
    await recordMfaFailedAttempt(userId, ipKey);
    throw new UnauthenticatedError("Invalid or expired MFA challenge");
  }
  // Single-use: burned as soon as it's confirmed real and unexpired,
  // regardless of whether the submitted code turns out to be correct.
  await db.verificationToken.deleteMany({ where: { token: tokenHash } });

  const credential = await db.mfaCredential.findUnique({ where: { userId } });
  if (!credential?.confirmedAt) {
    await recordMfaFailedAttempt(userId, ipKey);
    throw new UnauthenticatedError("Invalid or expired MFA challenge");
  }

  const secret = decryptMfaSecret(credential.secretEncrypted, authSecret());
  const totpResult = verifyTotpWithCounter(secret, submittedCode);
  let isValidTotp = false;
  if (totpResult.valid && totpResult.counter !== null) {
    // N-1 (Phase 1D): atomic replay-protection consume — the same pattern
    // as the recovery-code atomic consume below (originally an F-22 fix
    // for that path). A code within the ±1 step drift window is
    // cryptographically valid for up to ~90 seconds, but each individual
    // HOTP counter may only ever be ACCEPTED once: `count === 1` means
    // this call is the one that actually advanced
    // `last_used_totp_counter` past `totpResult.counter`; a second
    // submission of the exact same code (whether replayed by an attacker
    // who observed it, or the same request racing itself) matches zero
    // rows and is correctly treated as invalid, not double-accepted.
    const consumed = await db.mfaCredential.updateMany({
      where: {
        id: credential.id,
        OR: [
          { lastUsedTotpCounter: null },
          { lastUsedTotpCounter: { lt: totpResult.counter } },
        ],
      },
      data: { lastUsedTotpCounter: totpResult.counter },
    });
    isValidTotp = consumed.count === 1;
  }

  let isValidRecoveryCode = false;
  if (!isValidTotp) {
    const codeHash = hashRecoveryCode(submittedCode);
    const recoveryCode = await db.mfaRecoveryCode.findUnique({ where: { codeHash } });
    if (recoveryCode && recoveryCode.mfaCredentialId === credential.id) {
      // F-22 (Phase 1B.1): atomic conditional consume — closes a TOCTOU
      // race where two concurrent challenges could both read `usedAt:
      // null` before either write landed, letting the same recovery code
      // authenticate twice (found via a real Promise.all concurrency test,
      // apps/web/tests/integration/concurrencyRaces.test.ts). `count === 1`
      // means THIS call is the one that actually flipped `usedAt` from
      // NULL; a losing concurrent caller's identical UPDATE matches zero
      // rows (already non-null) and is correctly treated as an invalid
      // code rather than throwing or double-consuming.
      const consumed = await db.mfaRecoveryCode.updateMany({
        where: { id: recoveryCode.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      isValidRecoveryCode = consumed.count === 1;
    }
  }

  if (!isValidTotp && !isValidRecoveryCode) {
    await recordMfaFailedAttempt(userId, ipKey);
    await withPlatformAuditContext((tx) =>
      writeAuditEvent(tx, {
        tenantId: null,
        actorUserId: userId,
        actorType: "USER",
        action: AUDIT_ACTIONS.MFA_CHALLENGE_FAILED,
        entityType: "user",
        entityId: userId,
        outcome: "DENIED",
        // Never the submitted code, the TOTP secret, the matched counter,
        // or the challenge token — this event records only that a
        // challenge failed and for whom (F-3B's own documented
        // requirement, re-verified as part of N-1: see
        // apps/web/tests/integration/mfa.test.ts's audit-content assertion).
      }),
    );
    throw new UnauthenticatedError("Invalid verification code");
  }

  if (isValidRecoveryCode) {
    await withPlatformAuditContext((tx) =>
      writeAuditEvent(tx, {
        tenantId: null,
        actorUserId: userId,
        actorType: "USER",
        action: AUDIT_ACTIONS.MFA_RECOVERY_CODE_USED,
        entityType: "user",
        entityId: userId,
        outcome: "SUCCESS",
      }),
    );
  }

  await clearMfaAttempts(userId);

  await withPlatformAuditContext((tx) =>
    writeAuditEvent(tx, {
      tenantId: null,
      actorUserId: userId,
      actorType: "USER",
      action: AUDIT_ACTIONS.MFA_CHALLENGE_SUCCEEDED,
      entityType: "user",
      entityId: userId,
      outcome: "SUCCESS",
    }),
  );

  return { userId };
}
