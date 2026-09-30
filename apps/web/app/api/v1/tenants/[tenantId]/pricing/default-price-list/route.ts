import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  parseJsonBody,
  parseWithSchema,
  toPublicDefaultPriceListSelection,
} from "@/lib/api/schemas/pricingSchemas";
import { tenantWriteRoute } from "@/lib/api/tenantRoute";
import {
  SetDefaultPriceListSchema,
  setDefaultPriceList,
} from "@/lib/services/catalogDomain";

type Params = { tenantId: string };

export const PUT = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PRICE_LIST_ASSIGNMENT_SET_DEFAULT,
  legalEntityIdFrom: async (req) =>
    parseWithSchema(SetDefaultPriceListSchema, await parseJsonBody(req)).legalEntityId,
  handler: async (req, _requestId, _params, ctx) => {
    const result = await setDefaultPriceList(ctx, await parseJsonBody(req));
    return jsonOk({
      selection: toPublicDefaultPriceListSelection(result),
    });
  },
});
