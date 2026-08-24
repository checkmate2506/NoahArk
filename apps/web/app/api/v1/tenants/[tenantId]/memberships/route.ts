import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import { listMemberships } from "@/lib/services/membershipService";

type Params = { tenantId: string };

export const GET = apiHandler<Params>(async (req, requestId, { tenantId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const memberships = await listMemberships(ctx);
  return jsonOk({ memberships });
});
