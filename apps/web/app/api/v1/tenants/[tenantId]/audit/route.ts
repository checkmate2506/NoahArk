import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import { listAuditEvents } from "@/lib/services/auditService";

type Params = { tenantId: string };

export const GET = apiHandler<Params>(async (req, requestId, { tenantId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;
  const result = await listAuditEvents(ctx, { cursor, limit });
  return jsonOk(result);
});
