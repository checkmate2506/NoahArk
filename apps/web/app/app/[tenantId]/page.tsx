import { resolveTenantContextForPage } from "@/lib/context";
import { getTenant } from "@/lib/services/tenantService";
import { listLegalEntities } from "@/lib/services/legalEntityService";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
} from "@noahark/ui";

export default async function TenantOverviewPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  const ctx = await resolveTenantContextForPage(tenantId);
  const [tenant, legalEntities] = await Promise.all([
    getTenant(ctx),
    listLegalEntities(ctx),
  ]);

  const byJurisdiction = new Map<string, number>();
  for (const le of legalEntities) {
    byJurisdiction.set(le.jurisdiction, (byJurisdiction.get(le.jurisdiction) ?? 0) + 1);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{tenant.name}</h1>
        <p className="text-sm text-muted-foreground">{tenant.slug}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Legal entities</CardTitle>
            <CardDescription>{legalEntities.length} total</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {["SG", "MY", "ID"].map((jurisdiction) => (
              <Badge
                key={jurisdiction}
                variant={byJurisdiction.has(jurisdiction) ? "success" : "neutral"}
              >
                {jurisdiction}: {byJurisdiction.get(jurisdiction) ?? 0}
              </Badge>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tenant status</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant={tenant.status === "ACTIVE" ? "success" : "danger"}>
              {tenant.status}
            </Badge>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Legal entities</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {legalEntities.length === 0 ? (
            <p className="text-sm text-muted-foreground">No legal entities yet.</p>
          ) : (
            legalEntities.map((le) => (
              <div
                key={le.id}
                className="flex items-center justify-between rounded-md border border-border p-3"
              >
                <div>
                  <p className="text-sm font-medium">{le.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {le.jurisdiction} · {le.functionalCurrency} · {le.timeZone}
                  </p>
                </div>
                <Badge variant={le.status === "ACTIVE" ? "success" : "neutral"}>
                  {le.status}
                </Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
