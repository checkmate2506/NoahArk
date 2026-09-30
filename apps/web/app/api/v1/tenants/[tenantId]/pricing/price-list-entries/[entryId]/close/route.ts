import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { parseJsonBody, toPublicPriceListEntry } from "@/lib/api/schemas/pricingSchemas";
import { tenantWriteRoute } from "@/lib/api/tenantRoute";
import { closePriceListEntry } from "@/lib/services/catalogDomain";

type Params = { tenantId: string; entryId: string };

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PRICE_LIST_ENTRY_CLOSE,
  handler: async (req, _requestId, params, ctx) => {
    const entry = await closePriceListEntry(
      ctx,
      params.entryId,
      await parseJsonBody(req),
    );
    return jsonOk({ entry: toPublicPriceListEntry(entry) });
  },
});
