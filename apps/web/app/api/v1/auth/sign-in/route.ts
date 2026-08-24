import { z } from "zod";
import { RateLimitedError, UnauthenticatedError, ValidationError } from "@noahark/core";
import { getIdentityClient, withPlatformAuditContext } from "@noahark/db";
import { verifyPassword, DUMMY_PASSWORD_HASH } from "@noahark/auth";
import { AUDIT_ACTIONS } from "@noahark/audit";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { createSession, SESSION_COOKIE_NAME } from "@/lib/session";
import {
  isRateLimited,
  recordFailedAttempt,
  clearAttempts,
  isMfaRateLimited,
  extractClientIp,
  trustedProxyCountFromEnv,
} from "@/lib/rateLimiter";
import { writeAuditEvent } from "@/lib/services/auditService";
import { hasMfaEnabled, issueMfaChallengeToken } from "@/lib/services/mfaService";

const SignInSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export const POST = apiHandler(async (req, requestId) => {
  const body = await req.json().catch(() => null);
  const parsed = SignInSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid sign-in request");
  const { email, password } = parsed.data;

  // F-9 (Phase 1B.1): `ipAddress` (used for the audit trail) is kept as the
  // raw untrusted header value for observability — it is NEVER used as a
  // rate-limit key directly. `rateLimitIp` is the trusted-hop-extracted
  // value (or null if no trusted proxy is configured), which IS safe to
  // use as a key precisely because an untrusted value collapses to null
  // rather than being spoofable.
  const ipAddress = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const userAgent = req.headers.get("user-agent") ?? undefined;
  const rateLimitIp = extractClientIp(req, trustedProxyCountFromEnv());

  if (await isRateLimited(email, rateLimitIp)) {
    await withPlatformAuditContext((tx) =>
      writeAuditEvent(tx, {
        tenantId: null,
        actorType: "USER",
        action: AUDIT_ACTIONS.AUTH_SIGN_IN_FAILED,
        entityType: "user",
        afterData: { email, reason: "rate_limited" },
        outcome: "DENIED",
        requestId,
        ipAddress,
        userAgent,
      }),
    );
    throw new RateLimitedError("Too many sign-in attempts — try again later");
  }

  const db = getIdentityClient();
  const user = await db.user.findUnique({
    where: { email },
    include: { credential: true },
  });
  // F-9 (Phase 1B): ALWAYS runs a real Argon2id verify() — against the
  // user's actual hash if they exist, or a fixed dummy hash of identical
  // cost if they don't — so response timing cannot be used to distinguish
  // "no such account" from "wrong password for a real account" (a classic
  // account-enumeration side channel). The `!!user` short-circuit that
  // used to skip verifyPassword entirely for an unknown email is gone.
  const passwordMatches = await verifyPassword(
    user?.credential?.passwordHash ?? DUMMY_PASSWORD_HASH,
    password,
  );
  const valid = !!user && !!user.credential && !user.isDisabled && passwordMatches;

  if (!valid) {
    await recordFailedAttempt(email, rateLimitIp);
    await withPlatformAuditContext((tx) =>
      writeAuditEvent(tx, {
        tenantId: null,
        actorUserId: user?.id ?? null,
        actorType: "USER",
        action: AUDIT_ACTIONS.AUTH_SIGN_IN_FAILED,
        entityType: "user",
        entityId: user?.id ?? null,
        afterData: { email },
        outcome: "DENIED",
        requestId,
        ipAddress,
        userAgent,
      }),
    );
    throw new UnauthenticatedError("Invalid email or password");
  }

  clearAttempts(email);

  // F-3B: MFA gate. Password verification alone does not issue a session
  // for a user with confirmed MFA — a short-lived challenge token (proof
  // "the password was already correct") is returned instead, exchanged
  // for a session only after a valid TOTP/recovery code at
  // /api/v1/auth/mfa/challenge.
  if (await hasMfaEnabled(user.id)) {
    // N-1 (Phase 1D): refuse to issue ANOTHER challenge token once this
    // account's MFA counter is already at its limit — the account-level
    // rate limit is keyed by userId (see rateLimiter.ts's
    // isMfaRateLimited), not by any single token, so this check is what
    // actually prevents "re-submit the correct password to get a fresh
    // token and keep guessing" from bypassing the limit: a fresh token
    // would otherwise let an attacker skip straight back to
    // /mfa/challenge with a brand-new (but still account-locked) token.
    // This request has already proven the password is correct, so
    // returning 429 here reveals nothing to anyone who doesn't already
    // know it.
    if (await isMfaRateLimited(user.id, rateLimitIp)) {
      throw new RateLimitedError("Too many MFA attempts — try again later");
    }
    const challengeToken = await issueMfaChallengeToken(user.id);
    return jsonOk({ mfaRequired: true, challengeToken });
  }

  const { rawToken, expires } = await createSession(user.id);

  await withPlatformAuditContext((tx) =>
    writeAuditEvent(tx, {
      tenantId: null,
      actorUserId: user.id,
      actorType: "USER",
      action: AUDIT_ACTIONS.AUTH_SIGN_IN,
      entityType: "user",
      entityId: user.id,
      outcome: "SUCCESS",
      requestId,
      ipAddress,
      userAgent,
    }),
  );

  const response = jsonOk({ user: { id: user.id, email: user.email, name: user.name } });
  response.cookies.set(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires,
  });
  return response;
});
