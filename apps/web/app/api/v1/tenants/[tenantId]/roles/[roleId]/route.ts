import { ValidationError } from "@noahark/core";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import {
  updateRolePermissions,
  UpdateRolePermissionsSchema,
  deleteRole,
} from "@/lib/services/roleService";

type Params = { tenantId: string; roleId: string };

export const PATCH = apiHandler<Params>(async (req, requestId, { tenantId, roleId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const body = await req.json().catch(() => null);
  const parsed = UpdateRolePermissionsSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError("Invalid request body", { issues: parsed.error.issues });
  }
  const role = await updateRolePermissions(ctx, roleId, parsed.data);
  return jsonOk({ role });
});

export const DELETE = apiHandler<Params>(async (req, requestId, { tenantId, roleId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const result = await deleteRole(ctx, roleId);
  return jsonOk(result);
});
