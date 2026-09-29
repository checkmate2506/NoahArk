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
  toPublicCatalogItem,
  toPublicCatalogItemAssignment,
} from "@/lib/api/schemas/catalogSchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import {
  CreateCatalogItemSchema,
  ListCatalogItemsSchema,
  createCatalogItem,
  listCatalogItems,
} from "@/lib/services/catalogDomain";

type Params = { tenantId: string };

const LIST_SPEC = {
  cursor: LIST_QUERY_STRING,
  limit: LIST_QUERY_INTEGER,
  itemType: LIST_QUERY_STRING,
  status: LIST_QUERY_STRING,
  includeArchived: LIST_QUERY_BOOLEAN,
  categoryId: LIST_QUERY_STRING,
  q: LIST_QUERY_STRING,
} as const;

function listQuery(req: Request) {
  return parseWithSchema(
    ListCatalogItemsSchema,
    parseListQuery(new URL(req.url).searchParams, LIST_SPEC),
  );
}

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.CATALOG_ITEM_READ,
  handler: async (req, _requestId, _params, ctx) => {
    const result = await listCatalogItems(ctx, listQuery(req));
    return jsonOk({
      items: result.items.map(toPublicCatalogItem),
      nextCursor: result.nextCursor,
    });
  },
});

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.CATALOG_ITEM_CREATE,
  legalEntityIdFrom: async (req) =>
    parseWithSchema(CreateCatalogItemSchema, await parseJsonBody(req)).ownerLegalEntityId,
  handler: async (req, _requestId, _params, ctx) => {
    const created = await createCatalogItem(ctx, await parseJsonBody(req));
    return jsonOk(
      {
        item: toPublicCatalogItem(created.item),
        assignment: toPublicCatalogItemAssignment(created.assignment),
      },
      { status: 201 },
    );
  },
});
