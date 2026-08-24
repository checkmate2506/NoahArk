import { notFound } from "next/navigation";
import { resolveTenantContextForPage } from "@/lib/context";
import { listLegalEntities } from "@/lib/services/legalEntityService";
import {
  listLegalEntityMemberships,
  listMemberships,
} from "@/lib/services/membershipService";
import { can, PERMISSIONS } from "@noahark/authz";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  PermissionDeniedState,
} from "@noahark/ui";
import { GrantAccessForm } from "@/components/forms/GrantAccessForm";
import { RevokeAccessButton } from "@/components/forms/RevokeAccessButton";

export default async function LegalEntityDetailPage({
  params,
}: {
  params: Promise<{ tenantId: string; legalEntityId: string }>;
}) {
  const { tenantId, legalEntityId } = await params;
  const ctx = await resolveTenantContextForPage(tenantId);

  if (
    !can(ctx, { permission: PERMISSIONS.LEGAL_ENTITY_MEMBERSHIP_READ, legalEntityId })
  ) {
    return (
      <PermissionDeniedState description="You do not have access to this legal entity." />
    );
  }

  const [legalEntities, grants, allMemberships] = await Promise.all([
    listLegalEntities(ctx),
    listLegalEntityMemberships(ctx, legalEntityId),
    listMemberships(ctx),
  ]);

  const legalEntity = legalEntities.find((le) => le.id === legalEntityId);
  if (!legalEntity) notFound();

  const grantedUserIds = new Set(
    grants.filter((g) => g.status === "ACTIVE").map((g) => g.userId),
  );
  const candidates = allMemberships
    .filter(
      (m) =>
        m.status === "ACTIVE" && m.userId !== ctx.userId && !grantedUserIds.has(m.userId),
    )
    .map((m) => ({ id: m.id, userId: m.userId, label: m.user.name ?? m.user.email }));

  const canGrant = can(ctx, {
    permission: PERMISSIONS.LEGAL_ENTITY_MEMBERSHIP_GRANT,
    legalEntityId,
  });
  const canRevoke = can(ctx, {
    permission: PERMISSIONS.LEGAL_ENTITY_MEMBERSHIP_REVOKE,
    legalEntityId,
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">{legalEntity.name}</h1>
        <p className="text-sm text-muted-foreground">
          {legalEntity.jurisdiction} · {legalEntity.functionalCurrency} ·{" "}
          {legalEntity.timeZone}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Access</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {grants.filter((g) => g.status === "ACTIVE").length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No one has been granted access yet.
            </p>
          ) : (
            grants
              .filter((g) => g.status === "ACTIVE")
              .map((g) => (
                <div
                  key={g.id}
                  className="flex items-center justify-between rounded-md border border-border p-3"
                >
                  <span className="text-sm">{g.user.name ?? g.user.email}</span>
                  {canRevoke && g.userId !== ctx.userId && (
                    <RevokeAccessButton
                      tenantId={tenantId}
                      legalEntityId={legalEntityId}
                      userId={g.userId}
                    />
                  )}
                </div>
              ))
          )}
          {canGrant && (
            <div className="mt-2 border-t border-border pt-3">
              <GrantAccessForm
                tenantId={tenantId}
                legalEntityId={legalEntityId}
                candidates={candidates}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
