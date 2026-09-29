import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { parseJsonBody, toPublicCatalogItem } from "@/lib/api/schemas/catalogSchemas";
import { tenantWriteRoute } from "@/lib/api/tenantRoute";
import { transferCatalogItemOwnership } from "@/lib/services/catalogDomain";

type Params = { tenantId: string; catalogItemId: string };

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.CATALOG_ITEM_TRANSFER_OWNERSHIP,
  handler: async (req, _requestId, params, ctx) => {
    const item = await transferCatalogItemOwnership(
      ctx,
      params.catalogItemId,
      await parseJsonBody(req),
    );
    return jsonOk({ item: toPublicCatalogItem(item) });
  },
});
