import { ValidationError } from "@noahark/core";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import {
  listApprovalRequests,
  createAndSubmitDemoSubject,
  CreateDemoApprovalSubjectSchema,
} from "@/lib/services/approvalService";

type Params = { tenantId: string };

export const GET = apiHandler<Params>(async (req, requestId, { tenantId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const requests = await listApprovalRequests(ctx);
  return jsonOk({ requests });
});

export const POST = apiHandler<Params>(async (req, requestId, { tenantId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const body = await req.json().catch(() => null);
  const parsed = CreateDemoApprovalSubjectSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError("Invalid request body", { issues: parsed.error.issues });
  }
  const result = await createAndSubmitDemoSubject(ctx, parsed.data);
  return jsonOk(result, { status: 201 });
});
