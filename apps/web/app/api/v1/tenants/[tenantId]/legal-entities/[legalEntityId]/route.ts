import { ValidationError } from "@noahark/core";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import {
  updateLegalEntity,
  UpdateLegalEntitySchema,
} from "@/lib/services/legalEntityService";

type Params = { tenantId: string; legalEntityId: string };

export const PATCH = apiHandler<Params>(
  async (req, requestId, { tenantId, legalEntityId }) => {
    const ctx = await resolveTenantContext(req, requestId, tenantId);
    const body = await req.json().catch(() => null);
    const parsed = UpdateLegalEntitySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body", { issues: parsed.error.issues });
    }
    const legalEntity = await updateLegalEntity(ctx, legalEntityId, parsed.data);
    return jsonOk({ legalEntity });
  },
);
