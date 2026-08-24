import { ValidationError } from "@noahark/core";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import { listRoles, createRole, CreateRoleSchema } from "@/lib/services/roleService";

type Params = { tenantId: string };

export const GET = apiHandler<Params>(async (req, requestId, { tenantId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const roles = await listRoles(ctx);
  return jsonOk({ roles });
});

export const POST = apiHandler<Params>(async (req, requestId, { tenantId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const body = await req.json().catch(() => null);
  const parsed = CreateRoleSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError("Invalid request body", { issues: parsed.error.issues });
  }
  const role = await createRole(ctx, parsed.data);
  return jsonOk({ role }, { status: 201 });
});
