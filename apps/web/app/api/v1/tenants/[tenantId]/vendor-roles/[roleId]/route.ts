import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { parseJsonBody, toPublicRole } from "@/lib/api/schemas/partySchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import { getVendorRole, updateVendorRole } from "@/lib/services/partyDomain";

type Params = { tenantId: string; roleId: string };

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.VENDOR_ROLE_READ,
  handler: async (_req, _requestId, params, ctx) => {
    const role = await getVendorRole(ctx, params.roleId);
    return jsonOk({ vendorRole: toPublicRole(role) });
  },
});

export const PATCH = tenantWriteRoute<Params>({
  permission: PERMISSIONS.VENDOR_ROLE_UPDATE,
  handler: async (req, _requestId, params, ctx) => {
    const role = await updateVendorRole(ctx, params.roleId, await parseJsonBody(req));
    return jsonOk({ vendorRole: toPublicRole(role) });
  },
});
