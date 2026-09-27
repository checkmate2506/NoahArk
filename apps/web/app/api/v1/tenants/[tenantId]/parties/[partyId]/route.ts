import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { parseJsonBody, toPublicParty } from "@/lib/api/schemas/partySchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import { getParty, updateParty } from "@/lib/services/partyDomain";

type Params = { tenantId: string; partyId: string };

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.PARTY_READ,
  handler: async (_req, _requestId, params, ctx) => {
    const party = await getParty(ctx, params.partyId);
    return jsonOk({ party: toPublicParty(party) });
  },
});

export const PATCH = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PARTY_UPDATE,
  handler: async (req, _requestId, params, ctx) => {
    const body = await parseJsonBody(req);
    const party = await updateParty(ctx, params.partyId, body);
    return jsonOk({ party: toPublicParty(party) });
  },
});
