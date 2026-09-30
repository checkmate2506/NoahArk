import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { parseJsonBody, toPublicPriceList } from "@/lib/api/schemas/pricingSchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import { getPriceList, updatePriceList } from "@/lib/services/catalogDomain";

type Params = { tenantId: string; priceListId: string };

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.PRICE_LIST_READ,
  handler: async (_req, _requestId, params, ctx) => {
    const priceList = await getPriceList(ctx, params.priceListId);
    return jsonOk({ priceList: toPublicPriceList(priceList) });
  },
});

export const PATCH = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PRICE_LIST_UPDATE,
  handler: async (req, _requestId, params, ctx) => {
    const priceList = await updatePriceList(
      ctx,
      params.priceListId,
      await parseJsonBody(req),
    );
    return jsonOk({ priceList: toPublicPriceList(priceList) });
  },
});
