import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import {
  CreateInvitationSchema,
  createInvitation,
  listInvitations,
} from "@/lib/services/invitationService";
import { ValidationError } from "@noahark/core";

type Params = { tenantId: string };

export const GET = apiHandler<Params>(async (req, requestId, { tenantId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const invitations = await listInvitations(ctx);
  return jsonOk({ invitations });
});

export const POST = apiHandler<Params>(async (req, requestId, { tenantId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const body = await req.json().catch(() => null);
  const parsed = CreateInvitationSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid invitation request");
  // The raw token is returned to the caller ONCE — the admin UI is
  // responsible for surfacing it (Phase 1 has no production email
  // provider — AD-3 — so this IS the delivery mechanism alongside the
  // console log).
  const result = await createInvitation(ctx, parsed.data);
  return jsonOk(result);
});
