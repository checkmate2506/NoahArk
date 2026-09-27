import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { parseJsonBody, toPublicAddress } from "@/lib/api/schemas/partySchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import { getAddress, updateAddress } from "@/lib/services/partyDomain";

type Params = { tenantId: string; addressId: string };

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.PARTY_ADDRESS_READ,
  handler: async (_req, _requestId, params, ctx) => {
    const address = await getAddress(ctx, params.addressId);
    return jsonOk({ address: toPublicAddress(address) });
  },
});

export const PATCH = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PARTY_ADDRESS_UPDATE,
  handler: async (req, _requestId, params, ctx) => {
    const body = await parseJsonBody(req);
    const address = await updateAddress(ctx, params.addressId, body);
    return jsonOk({ address: toPublicAddress(address) });
  },
});
