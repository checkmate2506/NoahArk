import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import { revokeInvitation } from "@/lib/services/invitationService";

type Params = { tenantId: string; invitationId: string };

export const DELETE = apiHandler<Params>(
  async (req, requestId, { tenantId, invitationId }) => {
    const ctx = await resolveTenantContext(req, requestId, tenantId);
    const result = await revokeInvitation(ctx, invitationId);
    return jsonOk(result);
  },
);
