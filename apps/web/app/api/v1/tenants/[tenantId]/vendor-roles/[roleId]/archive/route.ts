import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  ExpectedVersionBodySchema,
  parseJsonBody,
  parseWithSchema,
  toPublicRole,
} from "@/lib/api/schemas/partySchemas";
import { tenantWriteRoute } from "@/lib/api/tenantRoute";
import { archiveVendorRole } from "@/lib/services/partyDomain";

type Params = { tenantId: string; roleId: string };

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.VENDOR_ROLE_ARCHIVE,
  handler: async (req, _requestId, params, ctx) => {
    const body = parseWithSchema(ExpectedVersionBodySchema, await parseJsonBody(req));
    const role = await archiveVendorRole(ctx, params.roleId, body.expectedVersion);
    return jsonOk({ vendorRole: toPublicRole(role) });
  },
});
