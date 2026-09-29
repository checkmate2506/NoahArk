import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  ExpectedVersionBodySchema,
  parseJsonBody,
  parseWithSchema,
  toPublicUnitOfMeasure,
} from "@/lib/api/schemas/catalogSchemas";
import { tenantWriteRoute } from "@/lib/api/tenantRoute";
import { deactivateUnitOfMeasure } from "@/lib/services/catalogDomain";

type Params = { tenantId: string; unitId: string };

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.UNIT_OF_MEASURE_SET_STATUS,
  handler: async (req, _requestId, params, ctx) => {
    const body = parseWithSchema(ExpectedVersionBodySchema, await parseJsonBody(req));
    const unit = await deactivateUnitOfMeasure(ctx, params.unitId, body);
    return jsonOk({ unit: toPublicUnitOfMeasure(unit) });
  },
});
