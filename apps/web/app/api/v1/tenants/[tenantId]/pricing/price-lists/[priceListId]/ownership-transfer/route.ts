import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { parseJsonBody, toPublicPriceList } from "@/lib/api/schemas/pricingSchemas";
import { tenantWriteRoute } from "@/lib/api/tenantRoute";
import { transferPriceListOwnership } from "@/lib/services/catalogDomain";

type Params = { tenantId: string; priceListId: string };

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PRICE_LIST_TRANSFER_OWNERSHIP,
  handler: async (req, _requestId, params, ctx) => {
    const priceList = await transferPriceListOwnership(
      ctx,
      params.priceListId,
      await parseJsonBody(req),
    );
    return jsonOk({ priceList: toPublicPriceList(priceList) });
  },
});
