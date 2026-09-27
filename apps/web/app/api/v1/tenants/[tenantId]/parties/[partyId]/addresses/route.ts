import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  LIST_QUERY_INTEGER,
  LIST_QUERY_STRING,
  parseListQuery,
} from "@/lib/api/listQuery";
import {
  parseJsonBody,
  parseWithSchema,
  toPublicAddress,
  withPathPartyId,
} from "@/lib/api/schemas/partySchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import {
  ListAddressesSchema,
  createAddress,
  listAddresses,
} from "@/lib/services/partyDomain";

type Params = { tenantId: string; partyId: string };

const LIST_SPEC = {
  cursor: LIST_QUERY_STRING,
  limit: LIST_QUERY_INTEGER,
} as const;

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.PARTY_ADDRESS_READ,
  handler: async (req, _requestId, params, ctx) => {
    const query = parseWithSchema(
      ListAddressesSchema,
      parseListQuery(new URL(req.url).searchParams, LIST_SPEC),
    );
    const result = await listAddresses(ctx, params.partyId, query);
    return jsonOk({
      addresses: result.items.map(toPublicAddress),
      nextCursor: result.nextCursor,
    });
  },
});

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PARTY_ADDRESS_CREATE,
  handler: async (req, _requestId, params, ctx) => {
    const body = withPathPartyId(params.partyId, await parseJsonBody(req));
    const address = await createAddress(ctx, body);
    return jsonOk({ address: toPublicAddress(address) }, { status: 201 });
  },
});
