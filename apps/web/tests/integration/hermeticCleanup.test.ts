import { describe, expect, it } from "vitest";
import { createSystemClient } from "@noahark/db/system";
import { withPlatformAuditContext, withTenantContext } from "@noahark/db";
import { AUDIT_ACTIONS } from "@noahark/audit";
import { writeAuditEvent } from "@/lib/services/auditService";
import { purgeOrphanedTestData } from "../testDataPurge";
import {
  setupTestTenant,
  cleanupUser,
  cleanupTenant,
  createTestUser,
  uniqueSlug,
} from "./testHelpers";

/**
 * N-4 (Phase 1D) regression coverage. Confirmed live, before this fix: 143
 * orphaned `@test.noahark.local` users had accumulated in the dev database
 * because `cleanupUser()` silently failed to delete any user who ever
 * produced a platform-level (tenantId=null) audit event — e.g. by signing
 * in — since AuditEvent.actor is a Restrict FK with no cascade. These tests
 * prove the fix directly, independent of the "run the suite N times"
 * empirical evidence gathered separately.
 */
describe("cleanupUser removes a user with platform-level audit history (N-4)", () => {
  it("deletes a user who has a tenantId=null AuditEvent referencing them as actor", async () => {
    const user = await createTestUser();

    // Mirrors exactly what apps/web/app/api/v1/auth/sign-in/route.ts writes
    // on a real sign-in: tenantId: null, actorUserId: user.id.
    await withPlatformAuditContext((tx) =>
      writeAuditEvent(tx, {
        tenantId: null,
        actorUserId: user.id,
        actorType: "USER",
        action: AUDIT_ACTIONS.AUTH_SIGN_IN,
        entityType: "user",
        entityId: user.id,
        outcome: "SUCCESS",
        requestId: `test-${user.id}`,
      }),
    );

    const db = createSystemClient();
    const auditRowBefore = await db.auditEvent.findFirst({
      where: { tenantId: null, actorUserId: user.id },
    });
    expect(auditRowBefore).not.toBeNull();

    await cleanupUser(user.id);

    const userAfter = await db.user.findUnique({ where: { id: user.id } });
    expect(userAfter).toBeNull();
    const auditRowAfter = await db.auditEvent.findFirst({
      where: { tenantId: null, actorUserId: user.id },
    });
    expect(auditRowAfter).toBeNull();
  });
});

describe("purgeOrphanedTestData (N-4)", () => {
  it("removes an orphaned test-pattern tenant and its tenant-scoped audit rows", async () => {
    const db = createSystemClient();
    const setup = await setupTestTenant();
    // Force the slug to look like debris left by an interrupted previous
    // run (setupTestTenant already uses the "test-tenant-" prefix, so no
    // rename needed — just confirm the assumption holds).
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: setup.tenantId } });
    expect(tenant.slug.startsWith("test-tenant-")).toBe(true);

    await withTenantContext(
      { tenantId: setup.tenantId, legalEntityIds: new Set<string>() },
      (tx) =>
        writeAuditEvent(tx, {
          tenantId: setup.tenantId,
          actorUserId: setup.adminUserId,
          actorType: "USER",
          action: "test.orphan_marker",
          entityType: "tenant",
          entityId: setup.tenantId,
          outcome: "SUCCESS",
          requestId: `test-${setup.tenantId}`,
        }),
    );

    const migrationUrl = process.env.DATABASE_MIGRATION_URL;
    if (!migrationUrl) throw new Error("DATABASE_MIGRATION_URL is not set");
    const result = await purgeOrphanedTestData(migrationUrl);
    expect(result.tenants).toBeGreaterThanOrEqual(1);

    const tenantAfter = await db.tenant.findUnique({ where: { id: setup.tenantId } });
    expect(tenantAfter).toBeNull();
    const auditAfter = await db.auditEvent.findFirst({
      where: { tenantId: setup.tenantId },
    });
    expect(auditAfter).toBeNull();

    // Already purged — cleanupUser afterEach-equivalent below must be a
    // harmless no-op for this tenant's admin user (already gone via the
    // platform-level path being untouched here; the user itself was never
    // deleted by the tenant purge, only tenant-scoped rows).
    await cleanupUser(setup.adminUserId);
  });

  it("removes an orphaned @test.noahark.local user not tied to any current tenant", async () => {
    const db = createSystemClient();
    const orphanEmail = `${uniqueSlug("orphan")}@test.noahark.local`;
    const orphan = await db.user.create({ data: { email: orphanEmail } });

    const migrationUrl = process.env.DATABASE_MIGRATION_URL;
    if (!migrationUrl) throw new Error("DATABASE_MIGRATION_URL is not set");
    const result = await purgeOrphanedTestData(migrationUrl);
    expect(result.users).toBeGreaterThanOrEqual(1);

    const after = await db.user.findUnique({ where: { id: orphan.id } });
    expect(after).toBeNull();
  });

  it("clears ALL outbox_event and background_job rows unconditionally (no real Phase 1 producers exist)", async () => {
    const db = createSystemClient();
    const setup = await setupTestTenant();
    await db.outboxEvent.create({
      data: { tenantId: setup.tenantId, eventType: "test.orphan_outbox", payload: {} },
    });
    await db.backgroundJob.create({
      data: { tenantId: setup.tenantId, jobType: "test.orphan_job", payload: {} },
    });

    const migrationUrl = process.env.DATABASE_MIGRATION_URL;
    if (!migrationUrl) throw new Error("DATABASE_MIGRATION_URL is not set");
    const result = await purgeOrphanedTestData(migrationUrl);
    expect(result.outboxEvents).toBeGreaterThanOrEqual(1);
    expect(result.backgroundJobs).toBeGreaterThanOrEqual(1);

    expect(await db.outboxEvent.count({ where: { tenantId: setup.tenantId } })).toBe(0);
    expect(await db.backgroundJob.count({ where: { tenantId: setup.tenantId } })).toBe(0);

    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("refuses to run against a connection string that looks production-like", async () => {
    await expect(
      purgeOrphanedTestData(
        "postgresql://user:pass@my-prod-db.postgres.database.azure.com:5432/noahark",
      ),
    ).rejects.toThrow(/looks like a production target/);
  });
});
