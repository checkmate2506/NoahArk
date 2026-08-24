import { resolveTenantContextForPage } from "@/lib/context";
import { listRoles } from "@/lib/services/roleService";
import { can, PERMISSIONS } from "@noahark/authz";
import { Card, CardHeader, CardTitle, CardContent, Badge } from "@noahark/ui";
import { CreateRoleForm } from "@/components/forms/CreateRoleForm";

export default async function RolesPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  const ctx = await resolveTenantContextForPage(tenantId);
  const roles = await listRoles(ctx);
  const canCreate = can(ctx, { permission: PERMISSIONS.ROLE_CREATE });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Roles &amp; permissions</h1>

      <div className="flex flex-col gap-3">
        {roles.map((role) => (
          <Card key={role.id}>
            <CardHeader>
              <div className="flex items-center gap-2">
                <CardTitle className="text-base">{role.name}</CardTitle>
                {role.isSystem && <Badge variant="neutral">System</Badge>}
              </div>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-1">
              {role.rolePermissions.map((rp) => (
                <Badge key={rp.id} variant="neutral">
                  {rp.permission.key}
                </Badge>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>

      {canCreate && (
        <CreateRoleForm
          tenantId={tenantId}
          availablePermissions={[...ctx.permissions].sort()}
        />
      )}
    </div>
  );
}
