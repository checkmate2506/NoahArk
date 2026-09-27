import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  ExpectedVersionBodySchema,
  parseJsonBody,
  parseWithSchema,
  toPublicAddress,
} from "@/lib/api/schemas/partySchemas";
import { tenantWriteRoute } from "@/lib/api/tenantRoute";
import { archiveAddress } from "@/lib/services/partyDomain";

type Params = { tenantId: string; addressId: string };

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PARTY_ADDRESS_ARCHIVE,
  handler: async (req, _requestId, params, ctx) => {
    const body = parseWithSchema(ExpectedVersionBodySchema, await parseJsonBody(req));
    const address = await archiveAddress(ctx, params.addressId, body.expectedVersion);
    return jsonOk({ address: toPublicAddress(address) });
  },
});
