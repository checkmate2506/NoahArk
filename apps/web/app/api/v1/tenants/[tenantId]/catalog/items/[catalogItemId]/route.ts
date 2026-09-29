import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { parseJsonBody, toPublicCatalogItem } from "@/lib/api/schemas/catalogSchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import { getCatalogItem, updateCatalogItem } from "@/lib/services/catalogDomain";

type Params = { tenantId: string; catalogItemId: string };

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.CATALOG_ITEM_READ,
  handler: async (_req, _requestId, params, ctx) => {
    const item = await getCatalogItem(ctx, params.catalogItemId);
    return jsonOk({ item: toPublicCatalogItem(item) });
  },
});

export const PATCH = tenantWriteRoute<Params>({
  permission: PERMISSIONS.CATALOG_ITEM_UPDATE,
  handler: async (req, _requestId, params, ctx) => {
    const item = await updateCatalogItem(
      ctx,
      params.catalogItemId,
      await parseJsonBody(req),
    );
    return jsonOk({ item: toPublicCatalogItem(item) });
  },
});
