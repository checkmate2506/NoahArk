import Link from "next/link";
import { redirect } from "next/navigation";
import { requireCurrentUser, listMyTenants } from "@/lib/context";
import { Card, CardHeader, CardTitle, CardContent, EmptyState } from "@noahark/ui";

export default async function TenantPickerPage() {
  const user = await requireCurrentUser();
  const tenants = await listMyTenants(user.id);

  if (tenants.length === 1 && tenants[0]) {
    redirect(`/app/${tenants[0].id}`);
  }

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="mb-6 text-xl font-semibold">Choose a workspace</h1>
      {tenants.length === 0 ? (
        <EmptyState
          title="No workspaces"
          description="You are not an active member of any tenant yet."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {tenants.map((tenant) => (
            <Link key={tenant.id} href={`/app/${tenant.id}`}>
              <Card className="transition-colors hover:bg-accent">
                <CardHeader>
                  <CardTitle>{tenant.name}</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 text-sm text-muted-foreground">
                  {tenant.slug}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
