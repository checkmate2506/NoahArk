import "dotenv/config";
import {
  createDisposableTestDatabase,
  dropDisposableTestDatabase,
  type DisposableTestDatabase,
} from "../testDbLifecycle";

/**
 * P1E-5 (Phase 1F): the integration suite now runs against its OWN
 * disposable database, created fresh here and dropped in teardown — never
 * the shared development database (`noahark`) a developer might have a
 * `pnpm --filter @noahark/web worker` running against. This is what makes
 * "a running development worker cannot compete for integration-test jobs"
 * true structurally (a worker connected to `noahark` cannot see rows in
 * `noahark_test_integration_...` — they are different databases on the
 * same server, not different tenants in one), not just documented as a
 * constraint developers must remember.
 *
 * `process.env.DATABASE_URL`/`DATABASE_MIGRATION_URL`/`DATABASE_WORKER_URL`
 * are overridden here, in vitest's `globalSetup` — this DOES propagate to
 * the actual worker process(es) that run test files (verified directly:
 * vitest spawns those workers, inheriting `process.env`, only after
 * `globalSetup`'s `setup()` completes), so every `getIdentityClient()`/
 * `createSystemClient()`/`getWorkerClient()` call in every test file
 * transparently talks to the disposable database with no per-test-file
 * change needed.
 */
let activeDb: DisposableTestDatabase | undefined;

export async function setup(): Promise<void> {
  const adminUrl = process.env.DATABASE_MIGRATION_URL;
  if (!adminUrl) {
    throw new Error(
      "DATABASE_MIGRATION_URL is not set. It is used here ONLY as the admin/owner " +
        "connection to CREATE the integration suite's own disposable database — copy " +
        ".env.example to packages/db/.env (and apps/web/.env) for local runs.",
    );
  }

  // NODE_ENV is typed readonly on process.env; this process-local override
  // only affects this globalSetup's own process (and any child it spawns
  // via an explicit env object) — never the developer's shell.
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  process.env.ALLOW_TEST_DB_PURGE = "1";

  const db = await createDisposableTestDatabase("integration", adminUrl);
  process.env.DATABASE_URL = db.appUrl;
  process.env.DATABASE_MIGRATION_URL = db.migrationUrl;
  process.env.DATABASE_WORKER_URL = db.workerUrl;

  console.warn(`[integration globalSetup] using disposable database "${db.name}"`);
  activeDb = db;
}

export async function teardown(): Promise<void> {
  if (!activeDb) return;
  await dropDisposableTestDatabase(activeDb);
  console.warn(
    `[integration globalSetup] dropped disposable database "${activeDb.name}"`,
  );
}
