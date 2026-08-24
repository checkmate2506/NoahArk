import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import { revokeLegalEntityAccess } from "@/lib/services/membershipService";

type Params = { tenantId: string; legalEntityId: string; userId: string };

export const DELETE = apiHandler<Params>(
  async (req, requestId, { tenantId, legalEntityId, userId }) => {
    const ctx = await resolveTenantContext(req, requestId, tenantId);
    const grant = await revokeLegalEntityAccess(ctx, legalEntityId, userId);
    return jsonOk({ grant });
  },
);
