import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { parseJsonBody, toPublicParty } from "@/lib/api/schemas/partySchemas";
import { tenantWriteRoute } from "@/lib/api/tenantRoute";
import { transferPartyOwnership } from "@/lib/services/partyDomain";

type Params = { tenantId: string; partyId: string };

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PARTY_TRANSFER_OWNERSHIP,
  handler: async (req, _requestId, params, ctx) => {
    const body = await parseJsonBody(req);
    const party = await transferPartyOwnership(ctx, params.partyId, body);
    return jsonOk({ party: toPublicParty(party) });
  },
});
