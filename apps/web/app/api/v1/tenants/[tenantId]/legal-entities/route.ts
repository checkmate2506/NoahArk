import { ValidationError } from "@noahark/core";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import {
  listLegalEntities,
  createLegalEntity,
  CreateLegalEntitySchema,
} from "@/lib/services/legalEntityService";

type Params = { tenantId: string };

export const GET = apiHandler<Params>(async (req, requestId, { tenantId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const legalEntities = await listLegalEntities(ctx);
  return jsonOk({ legalEntities });
});

export const POST = apiHandler<Params>(async (req, requestId, { tenantId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const body = await req.json().catch(() => null);
  const parsed = CreateLegalEntitySchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError("Invalid request body", { issues: parsed.error.issues });
  }
  const legalEntity = await createLegalEntity(ctx, parsed.data);
  return jsonOk({ legalEntity }, { status: 201 });
});
