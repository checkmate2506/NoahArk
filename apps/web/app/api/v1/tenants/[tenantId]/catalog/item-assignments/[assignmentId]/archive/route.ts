import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  ExpectedVersionBodySchema,
  parseJsonBody,
  parseWithSchema,
  toPublicCatalogItemAssignment,
} from "@/lib/api/schemas/catalogSchemas";
import { tenantWriteRoute } from "@/lib/api/tenantRoute";
import { archiveCatalogItemAssignment } from "@/lib/services/catalogDomain";

type Params = { tenantId: string; assignmentId: string };

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_ARCHIVE,
  handler: async (req, _requestId, params, ctx) => {
    const body = parseWithSchema(ExpectedVersionBodySchema, await parseJsonBody(req));
    const assignment = await archiveCatalogItemAssignment(
      ctx,
      params.assignmentId,
      body.expectedVersion,
    );
    return jsonOk({ assignment: toPublicCatalogItemAssignment(assignment) });
  },
});
