import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  LIST_QUERY_INTEGER,
  LIST_QUERY_STRING,
  parseListQuery,
} from "@/lib/api/listQuery";
import {
  parseJsonBody,
  parseWithSchema,
  toPublicPriceListAssignment,
} from "@/lib/api/schemas/pricingSchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import {
  CreatePriceListAssignmentSchema,
  ListPriceListAssignmentsSchema,
  createPriceListAssignment,
  listPriceListAssignments,
} from "@/lib/services/catalogDomain";

type Params = { tenantId: string };

const LIST_SPEC = {
  priceListId: LIST_QUERY_STRING,
  legalEntityId: LIST_QUERY_STRING,
  cursor: LIST_QUERY_STRING,
  limit: LIST_QUERY_INTEGER,
} as const;

function listQuery(req: Request) {
  return parseWithSchema(
    ListPriceListAssignmentsSchema,
    parseListQuery(new URL(req.url).searchParams, LIST_SPEC),
  );
}

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.PRICE_LIST_ASSIGNMENT_READ,
  legalEntityIdFrom: async (req) => listQuery(req).legalEntityId ?? null,
  handler: async (req, _requestId, _params, ctx) => {
    const result = await listPriceListAssignments(ctx, listQuery(req));
    return jsonOk({
      assignments: result.items.map(toPublicPriceListAssignment),
      nextCursor: result.nextCursor,
    });
  },
});

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PRICE_LIST_ASSIGNMENT_CREATE,
  legalEntityIdFrom: async (req) =>
    parseWithSchema(CreatePriceListAssignmentSchema, await parseJsonBody(req))
      .legalEntityId,
  handler: async (req, _requestId, _params, ctx) => {
    const assignment = await createPriceListAssignment(ctx, await parseJsonBody(req));
    return jsonOk(
      { assignment: toPublicPriceListAssignment(assignment) },
      { status: 201 },
    );
  },
});
