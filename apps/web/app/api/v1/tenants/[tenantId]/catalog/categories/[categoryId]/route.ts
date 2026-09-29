import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { parseJsonBody, toPublicCatalogCategory } from "@/lib/api/schemas/catalogSchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import { getCatalogCategory, updateCatalogCategory } from "@/lib/services/catalogDomain";

type Params = { tenantId: string; categoryId: string };

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.CATALOG_CATEGORY_READ,
  handler: async (_req, _requestId, params, ctx) => {
    const category = await getCatalogCategory(ctx, params.categoryId);
    return jsonOk({ category: toPublicCatalogCategory(category) });
  },
});

export const PATCH = tenantWriteRoute<Params>({
  permission: PERMISSIONS.CATALOG_CATEGORY_UPDATE,
  handler: async (req, _requestId, params, ctx) => {
    const category = await updateCatalogCategory(
      ctx,
      params.categoryId,
      await parseJsonBody(req),
    );
    return jsonOk({ category: toPublicCatalogCategory(category) });
  },
});
