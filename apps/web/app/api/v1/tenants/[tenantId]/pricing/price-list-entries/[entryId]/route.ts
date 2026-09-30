import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { parseJsonBody, toPublicPriceListEntry } from "@/lib/api/schemas/pricingSchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import { getPriceListEntry, updatePriceListEntry } from "@/lib/services/catalogDomain";

type Params = { tenantId: string; entryId: string };

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.PRICE_LIST_ENTRY_READ,
  handler: async (_req, _requestId, params, ctx) => {
    const entry = await getPriceListEntry(ctx, params.entryId);
    return jsonOk({ entry: toPublicPriceListEntry(entry) });
  },
});

export const PATCH = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PRICE_LIST_ENTRY_UPDATE,
  handler: async (req, _requestId, params, ctx) => {
    const entry = await updatePriceListEntry(
      ctx,
      params.entryId,
      await parseJsonBody(req),
    );
    return jsonOk({ entry: toPublicPriceListEntry(entry) });
  },
});
