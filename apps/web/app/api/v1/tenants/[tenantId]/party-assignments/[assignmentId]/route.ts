import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { parseJsonBody, toPublicAssignment } from "@/lib/api/schemas/partySchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import { getAssignment, updateAssignment } from "@/lib/services/partyDomain";

type Params = { tenantId: string; assignmentId: string };

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.PARTY_ASSIGNMENT_READ,
  handler: async (_req, _requestId, params, ctx) => {
    const assignment = await getAssignment(ctx, params.assignmentId);
    return jsonOk({ assignment: toPublicAssignment(assignment) });
  },
});

export const PATCH = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PARTY_ASSIGNMENT_UPDATE,
  handler: async (req, _requestId, params, ctx) => {
    const assignment = await updateAssignment(
      ctx,
      params.assignmentId,
      await parseJsonBody(req),
    );
    return jsonOk({ assignment: toPublicAssignment(assignment) });
  },
});
