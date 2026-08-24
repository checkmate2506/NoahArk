import { ValidationError } from "@noahark/core";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import {
  updateMembershipStatus,
  UpdateMembershipStatusSchema,
} from "@/lib/services/membershipService";

type Params = { tenantId: string; membershipId: string };

export const PATCH = apiHandler<Params>(
  async (req, requestId, { tenantId, membershipId }) => {
    const ctx = await resolveTenantContext(req, requestId, tenantId);
    const body = await req.json().catch(() => null);
    const parsed = UpdateMembershipStatusSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body", { issues: parsed.error.issues });
    }
    const membership = await updateMembershipStatus(ctx, membershipId, parsed.data);
    return jsonOk({ membership });
  },
);
