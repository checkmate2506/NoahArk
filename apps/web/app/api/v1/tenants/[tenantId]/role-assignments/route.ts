import { ValidationError } from "@noahark/core";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import { assignRole, AssignRoleSchema } from "@/lib/services/roleService";

type Params = { tenantId: string };

export const POST = apiHandler<Params>(async (req, requestId, { tenantId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const body = await req.json().catch(() => null);
  const parsed = AssignRoleSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError("Invalid request body", { issues: parsed.error.issues });
  }
  const assignment = await assignRole(ctx, parsed.data);
  return jsonOk({ assignment }, { status: 201 });
});
