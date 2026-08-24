import { resolveTenantContextForPage } from "@/lib/context";
import { listTenantSettings } from "@/lib/services/settingsService";
import { can, PERMISSIONS } from "@noahark/authz";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  PermissionDeniedState,
} from "@noahark/ui";
import { UpdateTenantSettingForm } from "@/components/forms/UpdateTenantSettingForm";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  const ctx = await resolveTenantContextForPage(tenantId);

  if (!can(ctx, { permission: PERMISSIONS.SETTINGS_READ })) {
    return <PermissionDeniedState />;
  }

  const settings = await listTenantSettings(ctx);
  const canUpdate = can(ctx, { permission: PERMISSIONS.SETTINGS_UPDATE });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tenant settings</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {settings.length === 0 ? (
            <p className="text-sm text-muted-foreground">No settings configured yet.</p>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {settings.map((s) => (
                <div key={s.id} className="contents">
                  <dt className="text-muted-foreground">{s.key}</dt>
                  <dd>{JSON.stringify(s.value)}</dd>
                </div>
              ))}
            </dl>
          )}
          {canUpdate && <UpdateTenantSettingForm tenantId={tenantId} />}
        </CardContent>
      </Card>
    </div>
  );
}
