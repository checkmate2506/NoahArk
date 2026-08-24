import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getIdentityClient, withPlatformAuditContext } from "@noahark/db";
import { ValidationError, UnauthenticatedError } from "@noahark/core";
import { AUDIT_ACTIONS } from "@noahark/audit";
import type { EmailProvider } from "@noahark/notifications";
import { writeAuditEvent } from "./auditService";
import { getSharedEmailProvider } from "../testEmailCapture";

/**
 * F-3A (Phase 1B): email verification, built on the EXISTING
 * `VerificationToken` table (Auth.js adapter contract — `identifier` +
 * `token` + `expires`; already present in schema.prisma, previously
 * granted to noahark_app but never used by any code path). No new table
 * was needed.
 *
 * Token is a random 256-bit value; only its SHA-256 hash is persisted
 * (mirrors session tokens and demo/invitation passwords — see
 * session.ts/seed.ts/invitationService.ts for the same pattern). Single
 * use: consumed (deleted) on successful verification. Resend supersedes:
 * requesting a new token deletes any other still-pending tokens for the
 * same identifier first, so an old, already-emailed link stops working the
 * moment a new one is requested. Generic responses throughout — never
 * reveal via a distinct error message whether a token existed, expired, or
 * was already used, to avoid a token-status oracle.
 */

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const IDENTIFIER_PREFIX = "email-verify:";

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export async function requestEmailVerification(
  userId: string,
  provider: EmailProvider = getSharedEmailProvider(),
): Promise<void> {
  const db = getIdentityClient();
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new UnauthenticatedError();
  if (user.emailVerified) return; // idempotent no-op — already verified

  const identifier = `${IDENTIFIER_PREFIX}${user.email}`;
  // Resend invalidates/supersedes any previous active token for this email.
  await db.verificationToken.deleteMany({ where: { identifier } });

  const rawToken = randomBytes(32).toString("base64url");
  await db.verificationToken.create({
    data: {
      identifier,
      token: hashToken(rawToken),
      expires: new Date(Date.now() + VERIFICATION_TTL_MS),
    },
  });

  await provider.send({
    to: user.email,
    subject: "Verify your NoahArk email address",
    body: `Verify your email: /verify-email?token=${rawToken}`,
  });

  await withPlatformAuditContext((tx) =>
    writeAuditEvent(tx, {
      tenantId: null,
      actorUserId: userId,
      actorType: "USER",
      action: AUDIT_ACTIONS.EMAIL_VERIFICATION_REQUESTED,
      entityType: "user",
      entityId: userId,
      outcome: "SUCCESS",
    }),
  );
}

export const ConfirmEmailVerificationSchema = z.object({ token: z.string().min(1) });

export async function confirmEmailVerification(rawToken: string): Promise<void> {
  const db = getIdentityClient();
  const tokenHash = hashToken(rawToken);
  const record = await db.verificationToken.findUnique({ where: { token: tokenHash } });

  if (
    !record ||
    !record.identifier.startsWith(IDENTIFIER_PREFIX) ||
    record.expires < new Date()
  ) {
    throw new ValidationError("Invalid or expired verification link");
  }

  // Single-use: delete immediately, before doing anything else, so a
  // concurrent replay of the same link cannot both succeed.
  const deleted = await db.verificationToken.deleteMany({ where: { token: tokenHash } });
  if (deleted.count === 0) {
    // Raced with another confirmation of the same token — treat identically.
    throw new ValidationError("Invalid or expired verification link");
  }

  const email = record.identifier.slice(IDENTIFIER_PREFIX.length);
  const user = await db.user.update({
    where: { email },
    data: { emailVerified: new Date() },
  });

  await withPlatformAuditContext((tx) =>
    writeAuditEvent(tx, {
      tenantId: null,
      actorUserId: user.id,
      actorType: "USER",
      action: AUDIT_ACTIONS.EMAIL_VERIFIED,
      entityType: "user",
      entityId: user.id,
      outcome: "SUCCESS",
    }),
  );
}
