import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  ExpectedVersionBodySchema,
  parseJsonBody,
  parseWithSchema,
  toPublicParty,
} from "@/lib/api/schemas/partySchemas";
import { tenantWriteRoute } from "@/lib/api/tenantRoute";
import { archiveParty } from "@/lib/services/partyDomain";

type Params = { tenantId: string; partyId: string };

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PARTY_ARCHIVE,
  handler: async (req, _requestId, params, ctx) => {
    const body = parseWithSchema(ExpectedVersionBodySchema, await parseJsonBody(req));
    const party = await archiveParty(ctx, params.partyId, body.expectedVersion);
    return jsonOk({ party: toPublicParty(party) });
  },
});
