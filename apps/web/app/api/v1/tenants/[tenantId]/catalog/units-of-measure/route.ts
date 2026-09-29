import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  LIST_QUERY_BOOLEAN,
  LIST_QUERY_INTEGER,
  LIST_QUERY_STRING,
  parseListQuery,
} from "@/lib/api/listQuery";
import {
  parseJsonBody,
  parseWithSchema,
  toPublicUnitOfMeasure,
} from "@/lib/api/schemas/catalogSchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import {
  ListUnitsOfMeasureSchema,
  createUnitOfMeasure,
  listUnitsOfMeasure,
} from "@/lib/services/catalogDomain";

type Params = { tenantId: string };

const LIST_SPEC = {
  cursor: LIST_QUERY_STRING,
  limit: LIST_QUERY_INTEGER,
  isActive: LIST_QUERY_BOOLEAN,
  q: LIST_QUERY_STRING,
} as const;

function listQuery(req: Request) {
  return parseWithSchema(
    ListUnitsOfMeasureSchema,
    parseListQuery(new URL(req.url).searchParams, LIST_SPEC),
  );
}

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.UNIT_OF_MEASURE_READ,
  handler: async (req, _requestId, _params, ctx) => {
    const result = await listUnitsOfMeasure(ctx, listQuery(req));
    return jsonOk({
      units: result.units.map(toPublicUnitOfMeasure),
      nextCursor: result.nextCursor,
    });
  },
});

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.UNIT_OF_MEASURE_CREATE,
  handler: async (req, _requestId, _params, ctx) => {
    const unit = await createUnitOfMeasure(ctx, await parseJsonBody(req));
    return jsonOk({ unit: toPublicUnitOfMeasure(unit) }, { status: 201 });
  },
});
