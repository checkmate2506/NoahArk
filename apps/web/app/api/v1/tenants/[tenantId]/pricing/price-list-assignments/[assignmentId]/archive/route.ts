import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  ExpectedVersionBodySchema,
  parseJsonBody,
  parseWithSchema,
  toPublicPriceListAssignment,
} from "@/lib/api/schemas/pricingSchemas";
import { tenantWriteRoute } from "@/lib/api/tenantRoute";
import { archivePriceListAssignment } from "@/lib/services/catalogDomain";

type Params = { tenantId: string; assignmentId: string };

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PRICE_LIST_ASSIGNMENT_ARCHIVE,
  handler: async (req, _requestId, params, ctx) => {
    const body = parseWithSchema(ExpectedVersionBodySchema, await parseJsonBody(req));
    const assignment = await archivePriceListAssignment(
      ctx,
      params.assignmentId,
      body.expectedVersion,
    );
    return jsonOk({ assignment: toPublicPriceListAssignment(assignment) });
  },
});
