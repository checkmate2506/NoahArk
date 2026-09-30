import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  parseJsonBody,
  toPublicPriceListAssignment,
} from "@/lib/api/schemas/pricingSchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import {
  getPriceListAssignment,
  updatePriceListAssignment,
} from "@/lib/services/catalogDomain";

type Params = { tenantId: string; assignmentId: string };

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.PRICE_LIST_ASSIGNMENT_READ,
  handler: async (_req, _requestId, params, ctx) => {
    const assignment = await getPriceListAssignment(ctx, params.assignmentId);
    return jsonOk({ assignment: toPublicPriceListAssignment(assignment) });
  },
});

export const PATCH = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PRICE_LIST_ASSIGNMENT_UPDATE,
  handler: async (req, _requestId, params, ctx) => {
    const assignment = await updatePriceListAssignment(
      ctx,
      params.assignmentId,
      await parseJsonBody(req),
    );
    return jsonOk({ assignment: toPublicPriceListAssignment(assignment) });
  },
});
