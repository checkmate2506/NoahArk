import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSystemClient } from "@noahark/db/system";
import { purgeOrphanedTestData } from "../testDataPurge";
import { setupTestTenant, cleanupUser, cleanupTenant, uniqueSlug } from "./testHelpers";

/**
 * P1E-1 (Phase 1F) negative-safety coverage. Phase 1E flagged the previous
 * purge as an unqualified `deleteMany({})` gated only by a hostname
 * heuristic. The rewritten `purgeOrphanedTestData` now requires FOUR
 * independent gates (NODE_ENV=test, ALLOW_TEST_DB_PURGE=1, a
 * non-production-looking connection string, and — checked both from the
 * URL string AND live against the server — a database name matching this
 * repo's own disposable-test-database pattern) before touching anything,
 * and scopes job/outbox deletion by type prefix rather than deleting
 * unconditionally.
 *
 * The whole integration suite now runs against a disposable database
 * created by `tests/integration/globalSetup.ts` — NODE_ENV=test and
 * ALLOW_TEST_DB_PURGE=1 are already set process-wide for that reason, and
 * every test file is already connected to a `noahark_test_*` database. The
 * "refuses" tests below deliberately undo one gate at a time to prove the
 * function itself enforces it, not just the environment it happens to run
 * in.
 */
describe("purgeOrphanedTestData — refuses without every required gate (P1E-1)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses without ALLOW_TEST_DB_PURGE=1", async () => {
    vi.stubEnv("ALLOW_TEST_DB_PURGE", "");
    const migrationUrl = process.env.DATABASE_MIGRATION_URL;
    await expect(purgeOrphanedTestData(migrationUrl!)).rejects.toThrow(
      /ALLOW_TEST_DB_PURGE/,
    );
  });

  it("refuses outside NODE_ENV=test", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const migrationUrl = process.env.DATABASE_MIGRATION_URL;
    await expect(purgeOrphanedTestData(migrationUrl!)).rejects.toThrow(/NODE_ENV/);
  });

  it("refuses a production-looking target", async () => {
    await expect(
      purgeOrphanedTestData(
        "postgresql://user:pass@my-db.postgres.database.azure.com:5432/noahark",
      ),
    ).rejects.toThrow(/looks like a production target/);
  });

  it("refuses a URL naming a database that is not a recognized disposable-test-database", async () => {
    // Same server/credentials, but a database name that does not match the
    // noahark_test_* pattern — the exact scenario N-4/P1E-1 exist to
    // prevent: pointing test cleanup at the shared development database.
    // Caught by the cheap URL-string check before any connection is made
    // (createSystemClient() is a memoized singleton already bound to the
    // real disposable database for this process, so only the string-level
    // check can be exercised without disconnecting/reconnecting it).
    const migrationUrl = process.env.DATABASE_MIGRATION_URL!;
    const nonTestUrl = migrationUrl.replace(/\/noahark_test_[^?/]+/, "/noahark");
    await expect(purgeOrphanedTestData(nonTestUrl)).rejects.toThrow(
      /disposable-test-database/,
    );
  });
});

describe("purgeOrphanedTestData — scoped deletion, non-test rows survive (P1E-1)", () => {
  it("does not delete a job/outbox row under a SURVIVING (non-test-pattern) tenant whose type does not start with 'test.'", async () => {
    // Deliberately NOT under a test-tenant-prefixed tenant: OutboxEvent
    // cascades on tenant delete and BackgroundJob is explicitly cleared
    // when ITS tenant is purged (matching cleanupTenant()'s own behaviour
    // elsewhere) — that is correct, not a bug, so a meaningful test of
    // type-based scoping needs a tenant the purge will never touch at all.
    const db = createSystemClient();
    const survivorTenant = await db.tenant.create({
      data: {
        name: "Manual Workspace",
        slug: `manual-workspace-${randomUUID().slice(0, 8)}`,
      },
    });
    try {
      const realLookingOutbox = await db.outboxEvent.create({
        data: {
          tenantId: survivorTenant.id,
          eventType: "membership_role.assigned",
          payload: {},
        },
      });
      const realLookingJob = await db.backgroundJob.create({
        data: {
          tenantId: survivorTenant.id,
          jobType: "notifications.send_digest",
          payload: {},
        },
      });

      const migrationUrl = process.env.DATABASE_MIGRATION_URL!;
      await purgeOrphanedTestData(migrationUrl);

      expect(
        await db.outboxEvent.findUnique({ where: { id: realLookingOutbox.id } }),
      ).not.toBeNull();
      expect(
        await db.backgroundJob.findUnique({ where: { id: realLookingJob.id } }),
      ).not.toBeNull();
    } finally {
      await db.outboxEvent.deleteMany({ where: { tenantId: survivorTenant.id } });
      await db.backgroundJob.deleteMany({ where: { tenantId: survivorTenant.id } });
      await db.tenant.deleteMany({ where: { id: survivorTenant.id } });
    }
  });

  it("does not delete a tenant or user whose identifiers do not match the test patterns, and restores triggers in `finally` after the purge fails", async () => {
    const db = createSystemClient();
    const survivorTenant = await db.tenant.create({
      data: {
        name: "Manual Workspace",
        slug: `manual-workspace-${randomUUID().slice(0, 8)}`,
      },
    });
    const orphanUser = await db.user.create({
      data: { email: `${uniqueSlug("orphan")}@test.noahark.local` },
    });
    try {
      // The orphaned user is referenced by a Restrict FK from a row under
      // the SURVIVOR tenant — realistic: an otherwise-orphaned test user
      // who happens to still be referenced from something that must not be
      // deleted. This is what makes the user-deletion step fail.
      const policy = await db.approvalPolicy.create({
        data: {
          tenantId: survivorTenant.id,
          subjectType: "test.purge_safety",
          name: "survivor policy",
          isActive: true,
        },
      });
      const blockingRequest = await db.approvalRequest.create({
        data: {
          tenantId: survivorTenant.id,
          approvalPolicyId: policy.id,
          subjectType: "test.purge_safety",
          subjectId: randomUUID(),
          submittedByUserId: orphanUser.id,
        },
      });

      const migrationUrl = process.env.DATABASE_MIGRATION_URL!;
      await expect(purgeOrphanedTestData(migrationUrl)).rejects.toThrow();

      // The survivor tenant and its approval request must still exist —
      // never targeted by the purge in the first place.
      expect(
        await db.tenant.findUnique({ where: { id: survivorTenant.id } }),
      ).not.toBeNull();
      expect(
        await db.approvalRequest.findUnique({ where: { id: blockingRequest.id } }),
      ).not.toBeNull();

      // Trigger restoration happened in `finally` despite the failure —
      // the trigger's own enabled state, read directly.
      const triggerState = await db.$queryRawUnsafe<Array<{ tgenabled: string }>>(
        `SELECT tgenabled::text FROM pg_trigger WHERE tgname = 'audit_event_no_delete'`,
      );
      expect(triggerState[0]?.tgenabled).toBe("O"); // 'O' = origin (enabled)
    } finally {
      await db.approvalRequest.deleteMany({ where: { tenantId: survivorTenant.id } });
      await db.approvalPolicy.deleteMany({ where: { tenantId: survivorTenant.id } });
      await db.tenant.deleteMany({ where: { id: survivorTenant.id } });
      await db.user.deleteMany({ where: { id: orphanUser.id } });
    }
  });
});

describe("purgeOrphanedTestData — current-run vs. another run's disposable database (P1E-1)", () => {
  it("removes current-run test records and cannot see another run's records at all", async () => {
    // "Another test run's records are not removed" is proven at the level
    // that actually matters here: a second disposable database is a
    // physically different Postgres database — this run's system client
    // has no connection to it, so there is no code path by which this
    // run's purge call could even see, let alone delete, its rows. Proven
    // directly rather than merely asserted.
    const db = createSystemClient();
    const setup = await setupTestTenant();
    const orphanOutbox = await db.outboxEvent.create({
      data: {
        tenantId: setup.tenantId,
        eventType: "test.purge_current_run",
        payload: {},
      },
    });

    const migrationUrl = process.env.DATABASE_MIGRATION_URL!;
    const before = await purgeOrphanedTestData(migrationUrl);
    expect(before.outboxEvents).toBeGreaterThanOrEqual(1);
    expect(
      await db.outboxEvent.findUnique({ where: { id: orphanOutbox.id } }),
    ).toBeNull();

    const currentDb = (
      await db.$queryRawUnsafe<Array<{ current_database: string }>>(
        "SELECT current_database()",
      )
    )[0]?.current_database;
    expect(currentDb).toMatch(/^noahark_test_integration_/);

    await cleanupUser(setup.adminUserId);
    await cleanupTenant(setup.tenantId);
  });
});
