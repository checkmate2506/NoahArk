import { resolveTenantContextForPage } from "@/lib/context";
import { listAuditEvents } from "@/lib/services/auditService";
import { can, PERMISSIONS } from "@noahark/authz";
import { Card, CardContent, Badge, EmptyState, PermissionDeniedState } from "@noahark/ui";

export default async function AuditPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  const ctx = await resolveTenantContextForPage(tenantId);

  if (!can(ctx, { permission: PERMISSIONS.AUDIT_READ })) {
    return <PermissionDeniedState />;
  }

  const { events } = await listAuditEvents(ctx, { limit: 50 });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Audit log</h1>
      {events.length === 0 ? (
        <EmptyState title="No audit events yet" />
      ) : (
        <div className="flex flex-col gap-2">
          {events.map((event) => (
            <Card key={event.id}>
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <p className="text-sm font-medium">{event.action}</p>
                  <p className="text-xs text-muted-foreground">
                    {event.entityType}
                    {event.entityId ? ` · ${event.entityId}` : ""} ·{" "}
                    {new Date(event.createdAt).toLocaleString()}
                  </p>
                </div>
                <Badge
                  variant={
                    event.outcome === "SUCCESS"
                      ? "success"
                      : event.outcome === "DENIED"
                        ? "danger"
                        : "warning"
                  }
                >
                  {event.outcome}
                </Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
