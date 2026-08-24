import { type AccessContext } from "@noahark/core";
import { withTenantContext } from "@noahark/db";
import { markNotificationRead } from "@noahark/notifications";

export async function listMyNotifications(ctx: AccessContext) {
  // No extra permission gate: a user may always see their own
  // notifications, scoped by recipientUserId (own-records only) rather
  // than a general permission.
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds },
    (tx) =>
      tx.notification.findMany({
        where: { tenantId: ctx.tenantId, recipientUserId: ctx.userId },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
  );
}

export async function markMyNotificationRead(ctx: AccessContext, notificationId: string) {
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    (tx) => markNotificationRead(tx, notificationId, ctx.userId),
  );
}
