import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import { markMyNotificationRead } from "@/lib/services/notificationService";

type Params = { tenantId: string; notificationId: string };

export const POST = apiHandler<Params>(
  async (req, requestId, { tenantId, notificationId }) => {
    const ctx = await resolveTenantContext(req, requestId, tenantId);
    await markMyNotificationRead(ctx, notificationId);
    return jsonOk({ read: true });
  },
);
