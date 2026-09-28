import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  ExpectedVersionBodySchema,
  parseJsonBody,
  parseWithSchema,
  toPublicAssignment,
} from "@/lib/api/schemas/partySchemas";
import { tenantWriteRoute } from "@/lib/api/tenantRoute";
import { revokeAssignment } from "@/lib/services/partyDomain";

type Params = { tenantId: string; assignmentId: string };

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PARTY_ASSIGNMENT_REVOKE,
  handler: async (req, _requestId, params, ctx) => {
    const body = parseWithSchema(ExpectedVersionBodySchema, await parseJsonBody(req));
    const assignment = await revokeAssignment(
      ctx,
      params.assignmentId,
      body.expectedVersion,
    );
    return jsonOk({ assignment: toPublicAssignment(assignment) });
  },
});
