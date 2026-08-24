import { ValidationError } from "@noahark/core";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import {
  listTenantSettings,
  updateTenantSetting,
  UpdateTenantSettingSchema,
} from "@/lib/services/settingsService";

type Params = { tenantId: string };

export const GET = apiHandler<Params>(async (req, requestId, { tenantId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const settings = await listTenantSettings(ctx);
  return jsonOk({ settings });
});

export const PATCH = apiHandler<Params>(async (req, requestId, { tenantId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const body = await req.json().catch(() => null);
  const parsed = UpdateTenantSettingSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError("Invalid request body", { issues: parsed.error.issues });
  }
  const setting = await updateTenantSetting(ctx, parsed.data);
  return jsonOk({ setting });
});
