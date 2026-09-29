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
  toPublicCatalogCategory,
} from "@/lib/api/schemas/catalogSchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import {
  ListCatalogCategoriesSchema,
  createCatalogCategory,
  listCatalogCategories,
} from "@/lib/services/catalogDomain";

type Params = { tenantId: string };

const LIST_SPEC = {
  cursor: LIST_QUERY_STRING,
  limit: LIST_QUERY_INTEGER,
  isActive: LIST_QUERY_BOOLEAN,
  q: LIST_QUERY_STRING,
} as const;

function listQuery(req: Request) {
  return parseWithSchema(
    ListCatalogCategoriesSchema,
    parseListQuery(new URL(req.url).searchParams, LIST_SPEC),
  );
}

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.CATALOG_CATEGORY_READ,
  handler: async (req, _requestId, _params, ctx) => {
    const result = await listCatalogCategories(ctx, listQuery(req));
    return jsonOk({
      categories: result.categories.map(toPublicCatalogCategory),
      nextCursor: result.nextCursor,
    });
  },
});

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.CATALOG_CATEGORY_CREATE,
  handler: async (req, _requestId, _params, ctx) => {
    const category = await createCatalogCategory(ctx, await parseJsonBody(req));
    return jsonOk({ category: toPublicCatalogCategory(category) }, { status: 201 });
  },
});
