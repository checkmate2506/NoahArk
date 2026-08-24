import { ValidationError } from "@noahark/core";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { SESSION_COOKIE_NAME } from "@/lib/session";
import {
  AcceptInvitationSchema,
  acceptInvitation,
} from "@/lib/services/invitationService";

/** Public — no session required (the invitation token itself is the
 * authorization artifact, same pattern as the signed file-download route). */
export const POST = apiHandler(async (req) => {
  const body = await req.json().catch(() => null);
  const parsed = AcceptInvitationSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid acceptance request");

  const { session, tenantId } = await acceptInvitation(parsed.data);

  const response = jsonOk({ tenantId });
  response.cookies.set(SESSION_COOKIE_NAME, session.rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: session.expires,
  });
  return response;
});
