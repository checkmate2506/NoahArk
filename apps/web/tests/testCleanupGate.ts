import { createSystemClient } from "@noahark/db/system";
import { assertDatabaseTargetIsSafe } from "@noahark/db";
import { isRecognizedTestDatabaseName } from "./testDbLifecycle";

/**
 * P1G-1 (Phase 1H): the shared four-gate safety check every helper that
 * disables the `audit_event` triggers or otherwise mutates/deletes
 * test-fixture rows via the superuser system client must pass before doing
 * so. Originally written (Phase 1F, P1E-1) only inside testDataPurge.ts's
 * `purgeOrphanedTestData` — Phase 1G's P1G-1 finding noted that
 * testHelpers.ts's `cleanupTenant`/`cleanupUser`, auditPagination.test.ts's
 * tied-timestamp fixture manipulation, and foundation.spec.ts's E2E
 * `afterAll` all performed the SAME trigger-disable-and-mutate pattern with
 * NO gates at all — safe today only because nothing currently points
 * `DATABASE_MIGRATION_URL` at a non-test database while running them, which
 * is an environmental accident, not a property the code itself enforces.
 * Extracted here so every one of those call sites goes through the
 * identical checks instead of each duplicating (and risking silently
 * weakening) its own copy.
 *
 * ALL of the following must hold:
 *   1. `NODE_ENV === "test"`.
 *   2. `ALLOW_TEST_DB_PURGE === "1"` — explicit, not opt-out.
 *   3. `assertDatabaseTargetIsSafe()` — the connection string itself must
 *      not look production-like (hostname/database-name heuristic).
 *   4. A DEDICATED TEST DATABASE IDENTITY — both the URL's own database
 *      name AND a LIVE `SELECT current_database()` against whatever
 *      `createSystemClient()` is actually connected to must match this
 *      repo's disposable-test-database naming pattern
 *      (`isRecognizedTestDatabaseName`, shared with testDbLifecycle.ts).
 *      The live check is the one that actually matters — it cannot be
 *      fooled by a URL string that merely looks right, and it is what
 *      makes "cleanup never touches the shared development database" true
 *      by construction (that database is named `noahark`, which never
 *      matches) rather than by convention.
 */
export async function assertTestCleanupAllowed(
  migrationUrl: string,
  purpose: string,
): Promise<void> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      `${purpose} — refusing: NODE_ENV must be "test" (was ${JSON.stringify(process.env.NODE_ENV)})`,
    );
  }
  if (process.env.ALLOW_TEST_DB_PURGE !== "1") {
    throw new Error(
      `${purpose} — refusing: set ALLOW_TEST_DB_PURGE=1 to explicitly confirm this is a test-only operation`,
    );
  }
  assertDatabaseTargetIsSafe(migrationUrl, purpose);

  const urlName = new URL(migrationUrl).pathname.replace(/^\//, "");
  if (!isRecognizedTestDatabaseName(urlName)) {
    throw new Error(
      `${purpose} — refusing: "${urlName}" does not match this repo's disposable-test-database ` +
        `naming pattern (see testDbLifecycle.ts).`,
    );
  }

  const db = createSystemClient();
  const rows = await db.$queryRawUnsafe<Array<{ current_database: string }>>(
    "SELECT current_database()",
  );
  const connectedName = rows[0]?.current_database;
  if (!connectedName || !isRecognizedTestDatabaseName(connectedName)) {
    throw new Error(
      `${purpose} — refusing: connected database "${connectedName}" does not match this repo's ` +
        `disposable-test-database naming pattern (see testDbLifecycle.ts). This gate exists ` +
        `specifically so cleanup can never run against the shared development database.`,
    );
  }
}

/**
 * Convenience wrapper for the call sites (testHelpers.ts, the E2E/
 * integration cleanup helpers) that have no caller-supplied connection
 * string of their own to check — they always operate against whatever
 * `createSystemClient()` is already connected to, via
 * `DATABASE_MIGRATION_URL` set process-wide by globalSetup.ts. Delegates to
 * `assertTestCleanupAllowed` above using that env var as the URL.
 * `purgeOrphanedTestData` (testDataPurge.ts) does NOT use this wrapper — it
 * takes an explicit `migrationUrl` argument and calls
 * `assertTestCleanupAllowed` directly, which is what lets its own negative
 * tests prove the check catches a caller-supplied URL that disagrees with
 * the live connection, not just a bad environment.
 */
export async function assertTestCleanupAllowedForCurrentEnv(
  purpose: string,
): Promise<void> {
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  if (!migrationUrl) {
    throw new Error(`${purpose} — refusing: DATABASE_MIGRATION_URL is not set`);
  }
  await assertTestCleanupAllowed(migrationUrl, purpose);
}

/**
 * Wraps the "gate, disable both audit_event triggers, run fn, always
 * re-enable in finally" pattern shared by every audit-mutating test helper
 * (testHelpers.ts's cleanupTenant/cleanupUser, auditPagination.test.ts's
 * tied-timestamp fixture, foundation.spec.ts's afterAll). Both triggers are
 * always disabled/re-enabled together even for callers that only need one
 * (e.g. an UPDATE-only fixture manipulation that never deletes anything) —
 * simpler than tracking which trigger each caller actually needs, and
 * disabling the unused one grants no capability the caller exercises.
 */
export async function withGatedAuditTriggerDisabled<T>(
  purpose: string,
  fn: (db: ReturnType<typeof createSystemClient>) => Promise<T>,
): Promise<T> {
  await assertTestCleanupAllowedForCurrentEnv(purpose);
  const db = createSystemClient();
  await db.$executeRawUnsafe(
    "ALTER TABLE audit_event DISABLE TRIGGER audit_event_no_update",
  );
  await db.$executeRawUnsafe(
    "ALTER TABLE audit_event DISABLE TRIGGER audit_event_no_delete",
  );
  try {
    return await fn(db);
  } finally {
    await db.$executeRawUnsafe(
      "ALTER TABLE audit_event ENABLE TRIGGER audit_event_no_update",
    );
    await db.$executeRawUnsafe(
      "ALTER TABLE audit_event ENABLE TRIGGER audit_event_no_delete",
    );
  }
}
