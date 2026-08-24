import { ValidationError } from "@noahark/core";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import { decideApproval, DecideApprovalSchema } from "@/lib/services/approvalService";

type Params = { tenantId: string; requestId: string };

export const POST = apiHandler<Params>(
  async (req, apiRequestId, { tenantId, requestId }) => {
    const ctx = await resolveTenantContext(req, apiRequestId, tenantId);
    const body = await req.json().catch(() => null);
    const parsed = DecideApprovalSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body", { issues: parsed.error.issues });
    }
    const result = await decideApproval(ctx, requestId, parsed.data);
    return jsonOk(result);
  },
);
