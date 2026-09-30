import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { LIST_QUERY_STRING, parseListQuery } from "@/lib/api/listQuery";
import {
  parseWithSchema,
  toPublicEffectivePrice,
} from "@/lib/api/schemas/pricingSchemas";
import { tenantReadRoute } from "@/lib/api/tenantRoute";
import {
  ResolveEffectivePriceSchema,
  resolveEffectivePrice,
} from "@/lib/services/catalogDomain";

type Params = { tenantId: string };

const QUERY_SPEC = {
  legalEntityId: LIST_QUERY_STRING,
  catalogItemId: LIST_QUERY_STRING,
  onDate: LIST_QUERY_STRING,
  priceListId: LIST_QUERY_STRING,
} as const;

function resolveQuery(req: Request) {
  return parseWithSchema(
    ResolveEffectivePriceSchema,
    parseListQuery(new URL(req.url).searchParams, QUERY_SPEC),
  );
}

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.PRICE_RESOLVE,
  legalEntityIdFrom: async (req) => resolveQuery(req).legalEntityId,
  handler: async (req, _requestId, _params, ctx) => {
    const result = await resolveEffectivePrice(ctx, resolveQuery(req));
    return jsonOk({ price: toPublicEffectivePrice(result) });
  },
});
