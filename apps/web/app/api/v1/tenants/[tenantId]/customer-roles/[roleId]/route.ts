import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { parseJsonBody, toPublicRole } from "@/lib/api/schemas/partySchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import { getCustomerRole, updateCustomerRole } from "@/lib/services/partyDomain";

type Params = { tenantId: string; roleId: string };

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.CUSTOMER_ROLE_READ,
  handler: async (_req, _requestId, params, ctx) => {
    const role = await getCustomerRole(ctx, params.roleId);
    return jsonOk({ customerRole: toPublicRole(role) });
  },
});

export const PATCH = tenantWriteRoute<Params>({
  permission: PERMISSIONS.CUSTOMER_ROLE_UPDATE,
  handler: async (req, _requestId, params, ctx) => {
    const role = await updateCustomerRole(ctx, params.roleId, await parseJsonBody(req));
    return jsonOk({ customerRole: toPublicRole(role) });
  },
});
