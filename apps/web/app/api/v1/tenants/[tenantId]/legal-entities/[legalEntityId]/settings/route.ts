import { ValidationError } from "@noahark/core";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import {
  listLegalEntitySettings,
  updateLegalEntitySetting,
  UpdateLegalEntitySettingSchema,
} from "@/lib/services/settingsService";

type Params = { tenantId: string; legalEntityId: string };

export const GET = apiHandler<Params>(
  async (req, requestId, { tenantId, legalEntityId }) => {
    const ctx = await resolveTenantContext(req, requestId, tenantId);
    const settings = await listLegalEntitySettings(ctx, legalEntityId);
    return jsonOk({ settings });
  },
);

export const PATCH = apiHandler<Params>(
  async (req, requestId, { tenantId, legalEntityId }) => {
    const ctx = await resolveTenantContext(req, requestId, tenantId);
    const body = await req.json().catch(() => null);
    const parsed = UpdateLegalEntitySettingSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body", { issues: parsed.error.issues });
    }
    const setting = await updateLegalEntitySetting(ctx, legalEntityId, parsed.data);
    return jsonOk({ setting });
  },
);
