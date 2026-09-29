import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  ExpectedVersionBodySchema,
  parseJsonBody,
  parseWithSchema,
  toPublicCatalogCategory,
} from "@/lib/api/schemas/catalogSchemas";
import { tenantWriteRoute } from "@/lib/api/tenantRoute";
import { activateCatalogCategory } from "@/lib/services/catalogDomain";

type Params = { tenantId: string; categoryId: string };

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.CATALOG_CATEGORY_SET_STATUS,
  handler: async (req, _requestId, params, ctx) => {
    const body = parseWithSchema(ExpectedVersionBodySchema, await parseJsonBody(req));
    const category = await activateCatalogCategory(ctx, params.categoryId, body);
    return jsonOk({ category: toPublicCatalogCategory(category) });
  },
});
