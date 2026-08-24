import Link from "next/link";
import { resolveTenantContextForPage } from "@/lib/context";
import { listLegalEntities } from "@/lib/services/legalEntityService";
import { can, PERMISSIONS } from "@noahark/authz";
import { Card, CardContent, Badge, EmptyState } from "@noahark/ui";
import { CreateLegalEntityForm } from "@/components/forms/CreateLegalEntityForm";

export default async function LegalEntitiesPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  const ctx = await resolveTenantContextForPage(tenantId);
  const legalEntities = await listLegalEntities(ctx);
  const canCreate = can(ctx, { permission: PERMISSIONS.LEGAL_ENTITY_CREATE });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Legal entities</h1>

      {legalEntities.length === 0 ? (
        <EmptyState
          title="No legal entities"
          description="Add your first legal entity below."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {legalEntities.map((le) => (
            <Link key={le.id} href={`/app/${tenantId}/legal-entities/${le.id}`}>
              <Card className="transition-colors hover:bg-accent">
                <CardContent className="flex items-center justify-between p-4">
                  <div>
                    <p className="text-sm font-medium">{le.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {le.jurisdiction} · {le.functionalCurrency} · {le.timeZone}
                    </p>
                  </div>
                  <Badge variant={le.status === "ACTIVE" ? "success" : "neutral"}>
                    {le.status}
                  </Badge>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {canCreate && <CreateLegalEntityForm tenantId={tenantId} />}
    </div>
  );
}
