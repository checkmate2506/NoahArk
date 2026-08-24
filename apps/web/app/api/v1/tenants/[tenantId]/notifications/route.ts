import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import { listMyNotifications } from "@/lib/services/notificationService";

type Params = { tenantId: string };

export const GET = apiHandler<Params>(async (req, requestId, { tenantId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const notifications = await listMyNotifications(ctx);
  return jsonOk({ notifications });
});
