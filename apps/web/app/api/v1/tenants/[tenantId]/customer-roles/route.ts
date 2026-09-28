import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { parseJsonBody, toPublicRole } from "@/lib/api/schemas/partySchemas";
import { tenantWriteRoute } from "@/lib/api/tenantRoute";
import { createCustomerRole } from "@/lib/services/partyDomain";

type Params = { tenantId: string };

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.CUSTOMER_ROLE_CREATE,
  handler: async (req, _requestId, _params, ctx) => {
    const role = await createCustomerRole(ctx, await parseJsonBody(req));
    return jsonOk({ customerRole: toPublicRole(role) }, { status: 201 });
  },
});
