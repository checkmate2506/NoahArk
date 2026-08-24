import { resolveTenantContextForPage } from "@/lib/context";
import { listMyNotifications } from "@/lib/services/notificationService";
import { Card, CardContent, EmptyState } from "@noahark/ui";
import { MarkNotificationReadButton } from "@/components/forms/MarkNotificationReadButton";

export default async function NotificationsPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  const ctx = await resolveTenantContextForPage(tenantId);
  const notifications = await listMyNotifications(ctx);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Notifications</h1>
      {notifications.length === 0 ? (
        <EmptyState title="No notifications" />
      ) : (
        <div className="flex flex-col gap-2">
          {notifications.map((n) => (
            <Card key={n.id}>
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <p className="text-sm font-medium">{n.title}</p>
                  <p className="text-xs text-muted-foreground">{n.body}</p>
                </div>
                {!n.readAt && (
                  <MarkNotificationReadButton tenantId={tenantId} notificationId={n.id} />
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
