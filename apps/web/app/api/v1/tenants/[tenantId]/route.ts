import { ValidationError } from "@noahark/core";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import {
  getTenant,
  updateTenant,
  UpdateTenantSchema,
} from "@/lib/services/tenantService";

type Params = { tenantId: string };

export const GET = apiHandler<Params>(async (req, requestId, { tenantId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const tenant = await getTenant(ctx);
  return jsonOk({ tenant });
});

export const PATCH = apiHandler<Params>(async (req, requestId, { tenantId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const body = await req.json().catch(() => null);
  const parsed = UpdateTenantSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError("Invalid request body", { issues: parsed.error.issues });
  }
  const tenant = await updateTenant(ctx, parsed.data);
  return jsonOk({ tenant });
});
