import { ValidationError } from "@noahark/core";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import {
  listLegalEntityMemberships,
  grantLegalEntityAccess,
  GrantLegalEntityAccessSchema,
} from "@/lib/services/membershipService";

type Params = { tenantId: string; legalEntityId: string };

export const GET = apiHandler<Params>(
  async (req, requestId, { tenantId, legalEntityId }) => {
    const ctx = await resolveTenantContext(req, requestId, tenantId);
    const grants = await listLegalEntityMemberships(ctx, legalEntityId);
    return jsonOk({ grants });
  },
);

export const POST = apiHandler<Params>(
  async (req, requestId, { tenantId, legalEntityId }) => {
    const ctx = await resolveTenantContext(req, requestId, tenantId);
    const body = await req.json().catch(() => null);
    const parsed = GrantLegalEntityAccessSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body", { issues: parsed.error.issues });
    }
    const grant = await grantLegalEntityAccess(ctx, legalEntityId, parsed.data);
    return jsonOk({ grant }, { status: 201 });
  },
);
