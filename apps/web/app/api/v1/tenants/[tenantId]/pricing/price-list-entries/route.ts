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
  toPublicPriceListEntry,
} from "@/lib/api/schemas/pricingSchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import {
  ListPriceListEntriesSchema,
  createPriceListEntry,
  listPriceListEntries,
} from "@/lib/services/catalogDomain";

type Params = { tenantId: string };

const LIST_SPEC = {
  cursor: LIST_QUERY_STRING,
  limit: LIST_QUERY_INTEGER,
  priceListAssignmentId: LIST_QUERY_STRING,
  catalogItemAssignmentId: LIST_QUERY_STRING,
  legalEntityId: LIST_QUERY_STRING,
} as const;

function listQuery(req: Request) {
  return parseWithSchema(
    ListPriceListEntriesSchema,
    parseListQuery(new URL(req.url).searchParams, LIST_SPEC),
  );
}

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.PRICE_LIST_ENTRY_READ,
  legalEntityIdFrom: async (req) => listQuery(req).legalEntityId ?? null,
  handler: async (req, _requestId, _params, ctx) => {
    const result = await listPriceListEntries(ctx, listQuery(req));
    return jsonOk({
      entries: result.items.map(toPublicPriceListEntry),
      nextCursor: result.nextCursor,
    });
  },
});

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PRICE_LIST_ENTRY_CREATE,
  handler: async (req, _requestId, _params, ctx) => {
    const entry = await createPriceListEntry(ctx, await parseJsonBody(req));
    return jsonOk({ entry: toPublicPriceListEntry(entry) }, { status: 201 });
  },
});
