import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveTenantContextForPage } from "@/lib/context";
import { getTenant } from "@/lib/services/tenantService";
import { can, PERMISSIONS } from "@noahark/authz";
import { isAppError } from "@noahark/core";
import { SignOutButton } from "@/components/SignOutButton";

export default async function TenantLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;

  let ctx;
  try {
    ctx = await resolveTenantContextForPage(tenantId);
  } catch (e) {
    if (isAppError(e)) notFound();
    throw e;
  }

  const tenant = await getTenant(ctx);

  const navItems = [
    { href: `/app/${tenantId}`, label: "Overview", visible: true },
    {
      href: `/app/${tenantId}/legal-entities`,
      label: "Legal entities",
      visible: can(ctx, { permission: PERMISSIONS.LEGAL_ENTITY_READ }),
    },
    {
      href: `/app/${tenantId}/users`,
      label: "Users & access",
      visible: can(ctx, { permission: PERMISSIONS.MEMBERSHIP_READ }),
    },
    {
      href: `/app/${tenantId}/roles`,
      label: "Roles & permissions",
      visible: can(ctx, { permission: PERMISSIONS.ROLE_READ }),
    },
    {
      href: `/app/${tenantId}/settings`,
      label: "Settings",
      visible: can(ctx, { permission: PERMISSIONS.SETTINGS_READ }),
    },
    {
      href: `/app/${tenantId}/audit`,
      label: "Audit log",
      visible: can(ctx, { permission: PERMISSIONS.AUDIT_READ }),
    },
    {
      href: `/app/${tenantId}/approvals`,
      label: "Approvals",
      visible: can(ctx, { permission: PERMISSIONS.APPROVAL_READ }),
    },
    { href: `/app/${tenantId}/notifications`, label: "Notifications", visible: true },
  ];

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 shrink-0 border-r border-border bg-card p-4">
        <div className="mb-6">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Workspace
          </p>
          <p className="font-semibold">{tenant.name}</p>
        </div>
        <nav aria-label="Primary" className="flex flex-col gap-1">
          {navItems
            .filter((item) => item.visible)
            .map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-3 py-2 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {item.label}
              </Link>
            ))}
        </nav>
        <div className="mt-8">
          <SignOutButton />
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-8">{children}</main>
    </div>
  );
}
