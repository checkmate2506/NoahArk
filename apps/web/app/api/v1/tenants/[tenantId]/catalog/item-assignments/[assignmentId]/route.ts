import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  parseJsonBody,
  toPublicCatalogItemAssignment,
} from "@/lib/api/schemas/catalogSchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import {
  getCatalogItemAssignment,
  updateCatalogItemAssignment,
} from "@/lib/services/catalogDomain";

type Params = { tenantId: string; assignmentId: string };

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_READ,
  handler: async (_req, _requestId, params, ctx) => {
    const assignment = await getCatalogItemAssignment(ctx, params.assignmentId);
    return jsonOk({ assignment: toPublicCatalogItemAssignment(assignment) });
  },
});

export const PATCH = tenantWriteRoute<Params>({
  permission: PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_UPDATE,
  handler: async (req, _requestId, params, ctx) => {
    const assignment = await updateCatalogItemAssignment(
      ctx,
      params.assignmentId,
      await parseJsonBody(req),
    );
    return jsonOk({ assignment: toPublicCatalogItemAssignment(assignment) });
  },
});
