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
  toPublicAssignment,
} from "@/lib/api/schemas/partySchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import {
  CreateAssignmentSchema,
  ListAssignmentsSchema,
  createAssignment,
  listAssignments,
} from "@/lib/services/partyDomain";

type Params = { tenantId: string };

const LIST_SPEC = {
  cursor: LIST_QUERY_STRING,
  limit: LIST_QUERY_INTEGER,
  partyId: LIST_QUERY_STRING,
  legalEntityId: LIST_QUERY_STRING,
} as const;

function listQuery(req: Request) {
  return parseWithSchema(
    ListAssignmentsSchema,
    parseListQuery(new URL(req.url).searchParams, LIST_SPEC),
  );
}

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.PARTY_ASSIGNMENT_READ,
  legalEntityIdFrom: async (req) => listQuery(req).legalEntityId ?? null,
  handler: async (req, _requestId, _params, ctx) => {
    const result = await listAssignments(ctx, listQuery(req));
    return jsonOk({
      assignments: result.items.map(toPublicAssignment),
      nextCursor: result.nextCursor,
    });
  },
});

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PARTY_ASSIGNMENT_CREATE,
  legalEntityIdFrom: async (req) =>
    parseWithSchema(CreateAssignmentSchema, await parseJsonBody(req)).legalEntityId,
  handler: async (req, _requestId, _params, ctx) => {
    const assignment = await createAssignment(ctx, await parseJsonBody(req));
    return jsonOk({ assignment: toPublicAssignment(assignment) }, { status: 201 });
  },
});
