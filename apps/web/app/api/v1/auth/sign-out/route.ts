import { cookies } from "next/headers";
import { withPlatformAuditContext } from "@noahark/db";
import { AUDIT_ACTIONS } from "@noahark/audit";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { invalidateSession, resolveSession, SESSION_COOKIE_NAME } from "@/lib/session";
import { writeAuditEvent } from "@/lib/services/auditService";

export const POST = apiHandler(async (req, requestId) => {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (raw) {
    const resolved = await resolveSession(raw);
    await invalidateSession(raw);
    if (resolved) {
      await withPlatformAuditContext((tx) =>
        writeAuditEvent(tx, {
          tenantId: null,
          actorUserId: resolved.user.id,
          actorType: "USER",
          action: AUDIT_ACTIONS.AUTH_SIGN_OUT,
          entityType: "user",
          entityId: resolved.user.id,
          outcome: "SUCCESS",
          requestId,
          ipAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
          userAgent: req.headers.get("user-agent") ?? undefined,
        }),
      );
    }
  }

  const response = jsonOk({ signedOut: true });
  response.cookies.delete(SESSION_COOKIE_NAME);
  return response;
});
