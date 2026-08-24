import { resolveTenantContextForPage } from "@/lib/context";
import { listMemberships } from "@/lib/services/membershipService";
import { listRoles } from "@/lib/services/roleService";
import { listLegalEntities } from "@/lib/services/legalEntityService";
import { listInvitations } from "@/lib/services/invitationService";
import { can, PERMISSIONS } from "@noahark/authz";
import { Card, CardContent, Badge, EmptyState } from "@noahark/ui";
import { AssignRoleForm } from "@/components/forms/AssignRoleForm";
import { InviteMemberForm } from "@/components/forms/InviteMemberForm";
import { RevokeInvitationButton } from "@/components/forms/RevokeInvitationButton";

export default async function UsersPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  const ctx = await resolveTenantContextForPage(tenantId);
  const canInvite = can(ctx, { permission: PERMISSIONS.MEMBERSHIP_INVITE });

  const [memberships, roles, legalEntities, invitations] = await Promise.all([
    listMemberships(ctx),
    can(ctx, { permission: PERMISSIONS.ROLE_READ })
      ? listRoles(ctx)
      : Promise.resolve([]),
    listLegalEntities(ctx),
    canInvite ? listInvitations(ctx) : Promise.resolve([]),
  ]);

  const canAssign = can(ctx, { permission: PERMISSIONS.ROLE_ASSIGN });
  const roleOptions = roles.map((r) => ({ id: r.id, name: r.name }));
  const legalEntityOptions = legalEntities.map((le) => ({ id: le.id, name: le.name }));
  const pendingInvitations = invitations.filter((i) => i.status === "PENDING");

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Users &amp; access</h1>

      {canInvite && (
        <InviteMemberForm
          tenantId={tenantId}
          roles={roleOptions}
          legalEntities={legalEntityOptions}
        />
      )}

      {canInvite && pendingInvitations.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Pending invitations
          </h2>
          {pendingInvitations.map((inv) => (
            <Card key={inv.id}>
              <CardContent className="flex items-center justify-between p-3">
                <div>
                  <p className="text-sm">{inv.email}</p>
                  <p className="text-xs text-muted-foreground">
                    Expires {new Date(inv.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                <RevokeInvitationButton tenantId={tenantId} invitationId={inv.id} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {memberships.length === 0 ? (
        <EmptyState title="No members" />
      ) : (
        <div className="flex flex-col gap-3">
          {memberships.map((m) => (
            <Card key={m.id}>
              <CardContent className="flex flex-col gap-3 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{m.user.name ?? m.user.email}</p>
                    <p className="text-xs text-muted-foreground">{m.user.email}</p>
                  </div>
                  <Badge variant={m.status === "ACTIVE" ? "success" : "danger"}>
                    {m.status}
                  </Badge>
                </div>
                {canAssign && m.userId !== ctx.userId && (
                  <AssignRoleForm
                    tenantId={tenantId}
                    tenantMembershipId={m.id}
                    roles={roleOptions}
                    legalEntities={legalEntityOptions}
                  />
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
