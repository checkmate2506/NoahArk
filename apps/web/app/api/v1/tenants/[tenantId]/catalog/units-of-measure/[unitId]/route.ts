import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { parseJsonBody, toPublicUnitOfMeasure } from "@/lib/api/schemas/catalogSchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import { getUnitOfMeasure, updateUnitOfMeasure } from "@/lib/services/catalogDomain";

type Params = { tenantId: string; unitId: string };

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.UNIT_OF_MEASURE_READ,
  handler: async (_req, _requestId, params, ctx) => {
    const unit = await getUnitOfMeasure(ctx, params.unitId);
    return jsonOk({ unit: toPublicUnitOfMeasure(unit) });
  },
});

export const PATCH = tenantWriteRoute<Params>({
  permission: PERMISSIONS.UNIT_OF_MEASURE_UPDATE,
  handler: async (req, _requestId, params, ctx) => {
    const unit = await updateUnitOfMeasure(ctx, params.unitId, await parseJsonBody(req));
    return jsonOk({ unit: toPublicUnitOfMeasure(unit) });
  },
});
