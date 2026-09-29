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
  toPublicCatalogItemAssignment,
} from "@/lib/api/schemas/catalogSchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import {
  CreateCatalogItemAssignmentSchema,
  ListCatalogItemAssignmentsSchema,
  createCatalogItemAssignment,
  listCatalogItemAssignments,
} from "@/lib/services/catalogDomain";

type Params = { tenantId: string };

const LIST_SPEC = {
  catalogItemId: LIST_QUERY_STRING,
  legalEntityId: LIST_QUERY_STRING,
  cursor: LIST_QUERY_STRING,
  limit: LIST_QUERY_INTEGER,
} as const;

function listQuery(req: Request) {
  return parseWithSchema(
    ListCatalogItemAssignmentsSchema,
    parseListQuery(new URL(req.url).searchParams, LIST_SPEC),
  );
}

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_READ,
  legalEntityIdFrom: async (req) => listQuery(req).legalEntityId ?? null,
  handler: async (req, _requestId, _params, ctx) => {
    const result = await listCatalogItemAssignments(ctx, listQuery(req));
    return jsonOk({
      assignments: result.items.map(toPublicCatalogItemAssignment),
      nextCursor: result.nextCursor,
    });
  },
});

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_CREATE,
  legalEntityIdFrom: async (req) =>
    parseWithSchema(CreateCatalogItemAssignmentSchema, await parseJsonBody(req))
      .legalEntityId,
  handler: async (req, _requestId, _params, ctx) => {
    const assignment = await createCatalogItemAssignment(ctx, await parseJsonBody(req));
    return jsonOk(
      { assignment: toPublicCatalogItemAssignment(assignment) },
      { status: 201 },
    );
  },
});
