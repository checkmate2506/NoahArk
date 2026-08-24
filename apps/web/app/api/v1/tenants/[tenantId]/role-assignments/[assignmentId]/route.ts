import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import { unassignRole } from "@/lib/services/roleService";

type Params = { tenantId: string; assignmentId: string };

export const DELETE = apiHandler<Params>(
  async (req, requestId, { tenantId, assignmentId }) => {
    const ctx = await resolveTenantContext(req, requestId, tenantId);
    const result = await unassignRole(ctx, assignmentId);
    return jsonOk(result);
  },
);
