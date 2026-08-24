import { createSystemClient } from "@noahark/db/system";
import { assertTestCleanupAllowed } from "./testCleanupGate";

/**
 * P1E-1 (Phase 1F): row-level test-data purge, rewritten after Phase 1E
 * flagged the original as an unsafe unqualified DELETE gated only by a
 * hostname heuristic. Phase 1F also introduced disposable per-run test
 * databases (`testDbLifecycle.ts`, P1E-5) — those are now the PRIMARY
 * isolation mechanism, and a freshly created+migrated disposable database
 * has nothing to purge in the first place. This function survives as a
 * defense-in-depth, independently-gated utility (for a workflow that
 * intentionally reuses one longer-lived test database across runs rather
 * than paying disposable-database setup cost every time) and is covered by
 * its own negative-safety tests.
 *
 * ALL of the following must hold before any DELETE runs:
 *   1. `NODE_ENV === "test"`.
 *   2. `ALLOW_TEST_DB_PURGE === "1"` — explicit, not opt-out.
 *   3. `assertDatabaseTargetIsSafe()` — the connection string itself must
 *      not look production-like (hostname/database-name heuristic).
 *   4. A DEDICATED TEST DATABASE IDENTITY — `SELECT current_database()`
 *      must match this repo's own disposable-test-database naming pattern
 *      (`isRecognizedTestDatabaseName`, shared with testDbLifecycle.ts).
 *      This is the gate that actually matters: it is checked LIVE against
 *      the server the caller is connected to, not just parsed out of a
 *      connection-string the caller supplied, so it cannot be fooled by a
 *      URL whose path merely LOOKS right. It is also what makes "tests
 *      never clean the ordinary development database" true by
 *      construction — the shared dev database is named `noahark`, which
 *      never matches, so this function refuses to run against it
 *      regardless of what env vars are set.
 *
 * Even having cleared all four gates, `outbox_event`/`background_job` are
 * NOT deleted unconditionally anymore — P1G-2 (Phase 1H): corrected a
 * doc-comment reference to a `purgeQueueDebris` helper that never existed
 * under that name; the actual logic is the two `TEST_JOB_TYPE_PREFIX`-scoped
 * `deleteMany` calls inside `purgeOrphanedTestData` below. An unqualified
 * deleteMany would have been wrong even inside a database this function has
 * already proven is test-only, because a disposable test database can still
 * carry real-looking (non-"test."-prefixed) fixture rows a test itself
 * created deliberately — see this file's own tests for that exact scenario.
 *
 * P1G-1 (Phase 1H): the four gates themselves now live in
 * `testCleanupGate.ts`'s `assertTestCleanupAllowed`, shared with every
 * other helper that mutates audit rows via the system client — this file
 * no longer keeps its own copy.
 */
const TEST_TENANT_SLUG_PREFIXES = ["test-tenant-", "e2e-"];
const TEST_USER_EMAIL_SUFFIX = "@test.noahark.local";
/** Every job/outbox row this test suite creates uses an event/job type
 * prefixed exactly this way — Phase 1 registers zero real handlers of any
 * kind (see apps/web/scripts/worker.ts), so nothing else could ever create
 * a row with this prefix. Scoping by type (rather than an unconditional
 * deleteMany) means a row that somehow doesn't match is preserved even
 * inside a database already proven to be test-only — belt AND suspenders,
 * not a replacement for the database-identity gate above. */
const TEST_JOB_TYPE_PREFIX = "test.";

export interface PurgeResult {
  outboxEvents: number;
  backgroundJobs: number;
  tenants: number;
  users: number;
}

export async function purgeOrphanedTestData(migrationUrl: string): Promise<PurgeResult> {
  const purpose = "Refusing to purge test data";
  await assertTestCleanupAllowed(migrationUrl, purpose);
  const db = createSystemClient();

  const outbox = await db.outboxEvent.deleteMany({
    where: { eventType: { startsWith: TEST_JOB_TYPE_PREFIX } },
  });
  const jobs = await db.backgroundJob.deleteMany({
    where: { jobType: { startsWith: TEST_JOB_TYPE_PREFIX } },
  });

  const orphanedTenants = await db.tenant.findMany({
    where: {
      OR: TEST_TENANT_SLUG_PREFIXES.map((prefix) => ({ slug: { startsWith: prefix } })),
    },
    select: { id: true },
  });
  const orphanedTenantIds = orphanedTenants.map((t) => t.id);

  const orphanedUsers = await db.user.findMany({
    where: { email: { endsWith: TEST_USER_EMAIL_SUFFIX } },
    select: { id: true },
  });
  const orphanedUserIds = orphanedUsers.map((u) => u.id);

  await db.$executeRawUnsafe(
    "ALTER TABLE audit_event DISABLE TRIGGER audit_event_no_update",
  );
  await db.$executeRawUnsafe(
    "ALTER TABLE audit_event DISABLE TRIGGER audit_event_no_delete",
  );
  try {
    if (orphanedTenantIds.length > 0) {
      await db.auditEvent.deleteMany({ where: { tenantId: { in: orphanedTenantIds } } });
      await db.backgroundJob.deleteMany({
        where: { tenantId: { in: orphanedTenantIds } },
      });
      await db.tenant.deleteMany({ where: { id: { in: orphanedTenantIds } } });
    }
    if (orphanedUserIds.length > 0) {
      await db.auditEvent.deleteMany({ where: { actorUserId: { in: orphanedUserIds } } });
      await db.user.deleteMany({ where: { id: { in: orphanedUserIds } } });
    }
  } finally {
    await db.$executeRawUnsafe(
      "ALTER TABLE audit_event ENABLE TRIGGER audit_event_no_update",
    );
    await db.$executeRawUnsafe(
      "ALTER TABLE audit_event ENABLE TRIGGER audit_event_no_delete",
    );
  }

  return {
    outboxEvents: outbox.count,
    backgroundJobs: jobs.count,
    tenants: orphanedTenantIds.length,
    users: orphanedUserIds.length,
  };
}
