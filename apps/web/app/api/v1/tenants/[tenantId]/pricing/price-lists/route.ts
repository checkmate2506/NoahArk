import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  LIST_QUERY_BOOLEAN,
  LIST_QUERY_INTEGER,
  LIST_QUERY_STRING,
  parseListQuery,
} from "@/lib/api/listQuery";
import {
  parseJsonBody,
  parseWithSchema,
  toPublicPriceList,
  toPublicPriceListAssignment,
} from "@/lib/api/schemas/pricingSchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import {
  CreatePriceListSchema,
  ListPriceListsSchema,
  createPriceList,
  listPriceLists,
} from "@/lib/services/catalogDomain";

type Params = { tenantId: string };

const LIST_SPEC = {
  cursor: LIST_QUERY_STRING,
  limit: LIST_QUERY_INTEGER,
  status: LIST_QUERY_STRING,
  includeArchived: LIST_QUERY_BOOLEAN,
  currency: LIST_QUERY_STRING,
  q: LIST_QUERY_STRING,
} as const;

function listQuery(req: Request) {
  return parseWithSchema(
    ListPriceListsSchema,
    parseListQuery(new URL(req.url).searchParams, LIST_SPEC),
  );
}

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.PRICE_LIST_READ,
  handler: async (req, _requestId, _params, ctx) => {
    const result = await listPriceLists(ctx, listQuery(req));
    return jsonOk({
      priceLists: result.items.map(toPublicPriceList),
      nextCursor: result.nextCursor,
    });
  },
});

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PRICE_LIST_CREATE,
  legalEntityIdFrom: async (req) =>
    parseWithSchema(CreatePriceListSchema, await parseJsonBody(req)).ownerLegalEntityId,
  handler: async (req, _requestId, _params, ctx) => {
    const created = await createPriceList(ctx, await parseJsonBody(req));
    return jsonOk(
      {
        priceList: toPublicPriceList(created.priceList),
        assignment: toPublicPriceListAssignment(created.assignment),
      },
      { status: 201 },
    );
  },
});
