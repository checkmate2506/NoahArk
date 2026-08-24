import { randomUUID } from "node:crypto";
import { createSystemClient } from "@noahark/db/system";
import { PERMISSION_CATALOG, SYSTEM_ROLES } from "@noahark/authz";
import type { AccessContext } from "@noahark/core";
import { getAccessContext } from "@/lib/context";
import { withGatedAuditTriggerDisabled } from "../testCleanupGate";

/**
 * Fixture setup for integration tests. Uses the SYSTEM (RLS-bypassing)
 * client to seed data — this is test scaffolding, not the code under test.
 * Every test's actual assertions exercise the normal RLS-enforced path via
 * buildContext() + the real service functions in lib/services/*.
 */

export function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export interface TestTenantSetup {
  tenantId: string;
  adminUserId: string;
  adminMembershipId: string;
  adminRoleId: string;
  memberRoleId: string;
}

export async function setupTestTenant(): Promise<TestTenantSetup> {
  const db = createSystemClient();

  for (const permission of PERMISSION_CATALOG) {
    await db.permission.upsert({
      where: { key: permission.key },
      create: permission,
      update: {},
    });
  }

  const tenant = await db.tenant.create({
    data: { name: uniqueSlug("Test Tenant"), slug: uniqueSlug("test-tenant") },
  });

  const permissions = await db.permission.findMany();
  const permissionByKey = new Map(permissions.map((p) => [p.key, p.id]));

  const adminRole = await db.role.create({
    data: {
      tenantId: tenant.id,
      key: SYSTEM_ROLES.TENANT_ADMIN.key,
      name: SYSTEM_ROLES.TENANT_ADMIN.name,
      isSystem: true,
      rolePermissions: {
        create: SYSTEM_ROLES.TENANT_ADMIN.permissions
          .map((key) => permissionByKey.get(key))
          .filter((id): id is string => Boolean(id))
          .map((permissionId) => ({ tenantId: tenant.id, permissionId })),
      },
    },
  });

  const memberRole = await db.role.create({
    data: {
      tenantId: tenant.id,
      key: SYSTEM_ROLES.MEMBER.key,
      name: SYSTEM_ROLES.MEMBER.name,
      isSystem: true,
      rolePermissions: {
        create: SYSTEM_ROLES.MEMBER.permissions
          .map((key) => permissionByKey.get(key))
          .filter((id): id is string => Boolean(id))
          .map((permissionId) => ({ tenantId: tenant.id, permissionId })),
      },
    },
  });

  const adminUser = await db.user.create({
    data: { email: `${uniqueSlug("admin")}@test.noahark.local`, name: "Test Admin" },
  });

  const adminMembership = await db.tenantMembership.create({
    data: { tenantId: tenant.id, userId: adminUser.id, status: "ACTIVE" },
  });

  await db.membershipRole.create({
    data: {
      tenantId: tenant.id,
      tenantMembershipId: adminMembership.id,
      roleId: adminRole.id,
      assignedByUserId: adminUser.id,
    },
  });

  return {
    tenantId: tenant.id,
    adminUserId: adminUser.id,
    adminMembershipId: adminMembership.id,
    adminRoleId: adminRole.id,
    memberRoleId: memberRole.id,
  };
}

export async function createTestUser(email?: string) {
  const db = createSystemClient();
  return db.user.create({
    data: { email: email ?? `${uniqueSlug("user")}@test.noahark.local` },
  });
}

export async function addTenantMember(
  tenantId: string,
  userId: string,
  status: "ACTIVE" | "SUSPENDED" = "ACTIVE",
) {
  const db = createSystemClient();
  return db.tenantMembership.create({ data: { tenantId, userId, status } });
}

export async function assignRoleDirect(
  tenantId: string,
  tenantMembershipId: string,
  roleId: string,
  assignedByUserId: string,
  legalEntityId: string | null = null,
) {
  const db = createSystemClient();
  return db.membershipRole.create({
    data: { tenantId, tenantMembershipId, roleId, assignedByUserId, legalEntityId },
  });
}

export async function grantLegalEntityAccessDirect(
  tenantId: string,
  legalEntityId: string,
  userId: string,
) {
  const db = createSystemClient();
  return db.legalEntityMembership.create({
    data: { tenantId, legalEntityId, userId, status: "ACTIVE" },
  });
}

const CURRENCY_BY_JURISDICTION = { SG: "SGD", MY: "MYR", ID: "IDR" } as const;
const TIMEZONE_BY_JURISDICTION = {
  SG: "Asia/Singapore",
  MY: "Asia/Kuala_Lumpur",
  ID: "Asia/Jakarta",
} as const;

export async function createTestLegalEntity(
  tenantId: string,
  jurisdiction: "SG" | "MY" | "ID" = "SG",
) {
  const db = createSystemClient();
  return db.legalEntity.create({
    data: {
      tenantId,
      name: uniqueSlug("Legal Entity"),
      jurisdiction,
      functionalCurrency: CURRENCY_BY_JURISDICTION[jurisdiction],
      timeZone: TIMEZONE_BY_JURISDICTION[jurisdiction],
    },
  });
}

export async function buildContext(
  userId: string,
  tenantId: string,
): Promise<AccessContext> {
  return getAccessContext(userId, tenantId, { requestId: `test-${randomUUID()}` });
}

/**
 * Cascades away everything tenant-owned. Call BEFORE cleanupUser() for any
 * user only referenced within this tenant (onDelete: Restrict on a few
 * "assigned/uploaded/created-by" FKs would otherwise block user deletion
 * while those tenant-owned rows still exist).
 *
 * audit_event's block trigger has NO role bypass (by design — see the RLS
 * migration's §3 comment: audit rows are immutable for every role,
 * including superusers, with no exception). That is correct production
 * behaviour, but it means cascade-deleting a test tenant that produced any
 * audit events would otherwise fail here. This is a TEST-ONLY concern:
 * Phase 1 has no tenant-deletion feature at all, so nothing in the running
 * application ever needs this. We disable the two audit triggers for the
 * duration of this single delete, as the superuser system client, and
 * always re-enable them immediately after — even on failure.
 *
 * F-16 (Phase 1B): AuditEvent's FKs to tenant/legalEntity/actor changed from
 * Cascade/SetNull to Restrict (the trigger already made both impossible in
 * practice — declaring Cascade/SetNull was misleading schema metadata; see
 * schema.prisma's AuditEvent doc comment). That means `tenant.delete()` can
 * no longer cascade away a tenant's audit_event rows for us — Postgres
 * rejects the delete via RESTRICT before the (disabled) trigger is even
 * relevant. So this function now explicitly DELETEs the tenant's
 * audit_event rows first (only possible with the trigger disabled), THEN
 * deletes the tenant. IMPORTANT: this file is the ONLY place in the
 * codebase permitted to delete an audit_event row, and only because Phase 1
 * has no tenant-deletion feature in the running application at all — this
 * is test-fixture teardown, not a capability the product exposes.
 *
 * BackgroundJob deliberately has NO Prisma relation to Tenant (unlike every
 * other tenant-owned table): it's cross-tenant queue infrastructure the
 * worker polls via its own RLS policy, and Phase 1 has no tenant-deletion
 * feature at all in the running application, so nothing production-facing
 * depends on cascade behaviour here. In a test suite that repeatedly
 * creates and deletes tenants, that means orphaned job rows would otherwise
 * accumulate across runs (and can then be claimed ahead of a *different*
 * test's freshly enqueued job, corrupting its assertions) — so we delete
 * them explicitly.
 *
 * P1G-1 (Phase 1H): now goes through `withGatedAuditTriggerDisabled`
 * (testCleanupGate.ts) — the same NODE_ENV/ALLOW_TEST_DB_PURGE/
 * safe-target/disposable-database-identity checks
 * `purgeOrphanedTestData` has always enforced, previously missing here.
 */
export async function cleanupTenant(tenantId: string): Promise<void> {
  await withGatedAuditTriggerDisabled("Refusing to clean up test tenant", async (db) => {
    await db.backgroundJob.deleteMany({ where: { tenantId } });
    await db.auditEvent.deleteMany({ where: { tenantId } });
    // deleteMany (not delete): idempotent by design — some call sites
    // (e.g. tests that stash a tenant id across multiple `it` blocks
    // without resetting it) call cleanupTenant twice for the same tenant.
    // A second call matching zero rows is expected and not an error; a
    // genuine FK-constraint failure still throws normally (not swallowed).
    await db.tenant.deleteMany({ where: { id: tenantId } });
  });
}

/**
 * N-4 (Phase 1D): platform-level (tenantId=null) AuditEvent rows — e.g.
 * AUTH_SIGN_IN/AUTH_SIGN_IN_FAILED, written outside any tenant context —
 * reference this user as `actor` via a Restrict FK with no cascade.
 * cleanupTenant() only clears TENANT-scoped audit rows, so any user who
 * signed in (or failed to) during a test still has platform-level rows
 * referencing them, which previously made `db.user.delete()` throw every
 * time — silently swallowed by a bare `.catch(() => undefined)`, so the
 * user row was never actually removed. Confirmed live before this fix: 143
 * orphaned `@test.noahark.local` users had accumulated in the dev database
 * purely from normal integration/E2E runs. Clearing actor-owned audit rows
 * first (same disable-trigger pattern as cleanupTenant — audit_event's
 * triggers block deletes for every role, including this superuser client)
 * makes the delete actually succeed, and `deleteMany` (not `delete`) keeps
 * this idempotent for call sites that clean up the same user twice, same
 * as cleanupTenant's own tenant delete.
 *
 * P1G-1 (Phase 1H): now goes through `withGatedAuditTriggerDisabled` — see
 * cleanupTenant's doc comment above.
 */
export async function cleanupUser(userId: string): Promise<void> {
  await withGatedAuditTriggerDisabled("Refusing to clean up test user", async (db) => {
    await db.auditEvent.deleteMany({ where: { actorUserId: userId } });
    await db.user.deleteMany({ where: { id: userId } });
  });
}
