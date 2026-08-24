import { afterEach, describe, expect, it, vi } from "vitest";
import { createSystemClient } from "@noahark/db/system";
import {
  assertTestCleanupAllowed,
  assertTestCleanupAllowedForCurrentEnv,
  withGatedAuditTriggerDisabled,
} from "../testCleanupGate";
import { cleanupTenant, cleanupUser, setupTestTenant, uniqueSlug } from "./testHelpers";

/**
 * P1G-1 (Phase 1H) negative-safety coverage for the shared gated-cleanup
 * primitive — mirrors testPurgeSafety.test.ts's coverage of
 * `purgeOrphanedTestData`'s own four gates, but exercises the SHARED
 * primitive every audit-trigger-disabling helper now goes through
 * (testHelpers.ts's cleanupTenant/cleanupUser, auditPagination.test.ts's
 * tied-timestamp fixture, foundation.spec.ts's E2E afterAll), proving the
 * gate itself refuses, not just `purgeOrphanedTestData`'s own copy.
 *
 * The whole integration suite runs against a disposable database created
 * by `tests/integration/globalSetup.ts` — NODE_ENV=test and
 * ALLOW_TEST_DB_PURGE=1 are already set process-wide. The "refuses" tests
 * below deliberately undo one gate at a time.
 */
describe("assertTestCleanupAllowed / withGatedAuditTriggerDisabled (P1G-1)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses without ALLOW_TEST_DB_PURGE=1", async () => {
    vi.stubEnv("ALLOW_TEST_DB_PURGE", "");
    await expect(
      assertTestCleanupAllowedForCurrentEnv("Refusing test cleanup"),
    ).rejects.toThrow(/ALLOW_TEST_DB_PURGE/);
  });

  it("refuses outside NODE_ENV=test", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(
      assertTestCleanupAllowedForCurrentEnv("Refusing test cleanup"),
    ).rejects.toThrow(/NODE_ENV/);
  });

  it("refuses a production-looking target", async () => {
    await expect(
      assertTestCleanupAllowed(
        "postgresql://user:pass@my-db.postgres.database.azure.com:5432/noahark",
        "Refusing test cleanup",
      ),
    ).rejects.toThrow(/looks like a production target/);
  });

  it("refuses a URL naming a database that is not a recognized disposable-test-database", async () => {
    const migrationUrl = process.env.DATABASE_MIGRATION_URL!;
    const nonTestUrl = migrationUrl.replace(/\/noahark_test_[^?/]+/, "/noahark");
    await expect(
      assertTestCleanupAllowed(nonTestUrl, "Refusing test cleanup"),
    ).rejects.toThrow(/disposable-test-database/);
  });

  it("refuses when DATABASE_MIGRATION_URL is not set", async () => {
    vi.stubEnv("DATABASE_MIGRATION_URL", "");
    await expect(
      assertTestCleanupAllowedForCurrentEnv("Refusing test cleanup"),
    ).rejects.toThrow(/DATABASE_MIGRATION_URL/);
  });

  it("succeeds and runs fn under the normal test environment, restoring triggers afterward", async () => {
    let ran = false;
    const result = await withGatedAuditTriggerDisabled("test op", async (db) => {
      ran = true;
      return db.$queryRawUnsafe<Array<{ current_database: string }>>(
        "SELECT current_database()",
      );
    });
    expect(ran).toBe(true);
    expect(result[0]?.current_database).toMatch(/^noahark_test_/);

    const db = createSystemClient();
    const triggerState = await db.$queryRawUnsafe<Array<{ tgenabled: string }>>(
      `SELECT tgenabled::text FROM pg_trigger WHERE tgname = 'audit_event_no_delete'`,
    );
    expect(triggerState[0]?.tgenabled).toBe("O"); // 'O' = origin (enabled)
  });

  it("withGatedAuditTriggerDisabled itself refuses (and never touches triggers) without ALLOW_TEST_DB_PURGE=1", async () => {
    vi.stubEnv("ALLOW_TEST_DB_PURGE", "");
    let ran = false;
    await expect(
      withGatedAuditTriggerDisabled("test op", async () => {
        ran = true;
      }),
    ).rejects.toThrow(/ALLOW_TEST_DB_PURGE/);
    expect(ran).toBe(false);
  });
});

describe("cleanupTenant / cleanupUser refuse without the shared gate (P1G-1)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("cleanupTenant refuses outside NODE_ENV=test and leaves the tenant intact", async () => {
    const setup = await setupTestTenant();
    vi.stubEnv("NODE_ENV", "development");
    await expect(cleanupTenant(setup.tenantId)).rejects.toThrow(/NODE_ENV/);
    vi.unstubAllEnvs();

    const db = createSystemClient();
    expect(await db.tenant.findUnique({ where: { id: setup.tenantId } })).not.toBeNull();
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("cleanupUser refuses without ALLOW_TEST_DB_PURGE=1 and leaves the user intact", async () => {
    const db = createSystemClient();
    const user = await db.user.create({
      data: { email: `${uniqueSlug("gate-test")}@test.noahark.local` },
    });
    vi.stubEnv("ALLOW_TEST_DB_PURGE", "");
    await expect(cleanupUser(user.id)).rejects.toThrow(/ALLOW_TEST_DB_PURGE/);
    vi.unstubAllEnvs();

    expect(await db.user.findUnique({ where: { id: user.id } })).not.toBeNull();
    await cleanupUser(user.id);
  });
});
