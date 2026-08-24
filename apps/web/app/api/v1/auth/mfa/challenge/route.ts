import { ValidationError } from "@noahark/core";
import { AUDIT_ACTIONS } from "@noahark/audit";
import { withPlatformAuditContext } from "@noahark/db";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { createSession, SESSION_COOKIE_NAME } from "@/lib/session";
import { VerifyMfaChallengeSchema, verifyMfaChallenge } from "@/lib/services/mfaService";
import { writeAuditEvent } from "@/lib/services/auditService";
import { extractClientIp, trustedProxyCountFromEnv } from "@/lib/rateLimiter";

/** Public — the challenge token (issued only after correct password
 * verification) is the authorization artifact. Completes sign-in on a
 * valid TOTP/recovery code. N-1 (Phase 1D): rate-limited — see
 * verifyMfaChallenge's own doc comment for the full design. */
export const POST = apiHandler(async (req, requestId) => {
  const body = await req.json().catch(() => null);
  const parsed = VerifyMfaChallengeSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid challenge request");

  const rateLimitIp = extractClientIp(req, trustedProxyCountFromEnv());
  const { userId } = await verifyMfaChallenge(
    parsed.data.challengeToken,
    parsed.data.code,
    rateLimitIp,
  );
  const { rawToken, expires } = await createSession(userId);

  await withPlatformAuditContext((tx) =>
    writeAuditEvent(tx, {
      tenantId: null,
      actorUserId: userId,
      actorType: "USER",
      action: AUDIT_ACTIONS.AUTH_SIGN_IN,
      entityType: "user",
      entityId: userId,
      outcome: "SUCCESS",
      requestId,
    }),
  );

  const response = jsonOk({ signedIn: true });
  response.cookies.set(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires,
  });
  return response;
});
