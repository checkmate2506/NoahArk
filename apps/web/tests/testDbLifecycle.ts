import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertDatabaseTargetIsSafe } from "@noahark/db";

/**
 * P1E-5 (Phase 1F): per-run disposable test databases — the primary fix for
 * "a running development worker competes for integration-test jobs"
 * (Phase 1E's P1E-5 finding) and for the broader hermeticity goal N-4
 * started. Each integration or E2E run gets its OWN, uniquely-named
 * PostgreSQL database, provisioned and migrated from scratch, used for
 * exactly that one run, then dropped. A worker pointed at the ordinary
 * development database (`noahark`) can never see — let alone claim — a row
 * that lives in `noahark_test_<label>_<...>`, because it is a physically
 * different database on the same server, not a different tenant within a
 * shared one.
 *
 * This also changes what "hermetic" means for `testDataPurge.ts`'s row-
 * level purge: within a database created by THIS module, every row that
 * could possibly exist was put there by a test, because nothing else has
 * ever connected to it — see that file's own doc comment for how it uses
 * `isRecognizedTestDatabase` as its primary safety gate instead of (or
 * alongside) name/email prefix matching.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const DB_PACKAGE_DIR = path.join(REPO_ROOT, "packages", "db");

/** Any database matching this pattern was created by `createDisposableTestDatabase`
 * — never a name a human would choose for a real environment. Exported so
 * `testDataPurge.ts` can use the identical check as one of its own gates. */
const TEST_DATABASE_NAME_PATTERN = /^noahark_test_[a-z0-9]+_\d+_[0-9a-f]{8}$/;

export function isRecognizedTestDatabaseName(name: string): boolean {
  return TEST_DATABASE_NAME_PATTERN.test(name);
}

/**
 * P1G-8 (Phase 1H): a small grace period applied AFTER a database has
 * already been proven abandoned by the advisory-lock + pg_stat_activity
 * checks below — not the staleness decision itself. It exists only to
 * absorb the narrow window between `CREATE DATABASE` and this module's own
 * `pg_advisory_lock` call a few lines later in `createDisposableTestDatabase`
 * (a sweep landing inside that gap would otherwise see "lock acquirable,
 * zero connections yet" for a database that is, in fact, about to be
 * owned). Deliberately short — this is a startup race window, not a
 * "how long may a run take" budget, which the lock+connection checks
 * already handle correctly for any duration. Age is NEVER, by itself, a
 * reason to drop a database that the lock/connection checks say is still
 * owned or still connected to.
 */
const STALE_DATABASE_MIN_AGE_MS = 60 * 1000;

/** The advisory-lock key for a disposable database is always derived the
 * same way, from its own (already-unique) name — `hashtext($1)` in the
 * queries below returns int4, which Postgres implicitly widens to the
 * bigint `pg_advisory_lock`/`pg_try_advisory_lock`/`pg_advisory_unlock`
 * overloads. Two different disposable databases could theoretically
 * hash-collide (a 32-bit space), which would only ever cause an unrelated
 * run's sweep candidacy to be conservatively skipped for one cycle — never
 * a false "safe to drop" — so a collision is not a safety concern here. */

function maintenanceUrlFor(adminUrl: URL): string {
  const u = new URL(adminUrl.toString());
  u.pathname = "/postgres";
  return u.toString();
}

function urlForDatabase(
  adminUrl: URL,
  databaseName: string,
  username: string,
  password: string,
): string {
  const u = new URL(adminUrl.toString());
  u.username = username;
  u.password = password;
  u.pathname = `/${databaseName}`;
  return u.toString();
}

function assertTestPurgeAllowed(purpose: string): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      `${purpose} — refusing: NODE_ENV must be "test" (was ${JSON.stringify(process.env.NODE_ENV)})`,
    );
  }
  if (process.env.ALLOW_TEST_DB_PURGE !== "1") {
    throw new Error(
      `${purpose} — refusing: set ALLOW_TEST_DB_PURGE=1 to explicitly confirm this is a disposable test database operation`,
    );
  }
}

/**
 * P1G-8 (Phase 1H): drops abandoned `noahark_test_*` databases —
 * self-healing against a run that crashed before it could drop its own
 * database (mirrors N-4's "never trust the previous run's exit code"
 * principle, now applied to whole databases). Gated identically to the
 * row-level purge (NODE_ENV=test, ALLOW_TEST_DB_PURGE=1, safe-target) —
 * this is still a DROP DATABASE, so it gets no less scrutiny than a DELETE
 * would.
 *
 * Rewritten from an age-only heuristic (Phase 1F) to ownership-based
 * detection, matching what an "active run" actually IS: a process holding
 * a session-level `pg_advisory_lock` keyed off the database's own name
 * (acquired by `createDisposableTestDatabase` below and held for the
 * database's whole lifetime — auto-released by PostgreSQL if that process
 * crashes, no manual cleanup required). For each `noahark_test_%`-pattern
 * candidate:
 *   1. Try to acquire the SAME advisory lock key on a throwaway connection
 *      (`pg_try_advisory_lock` — non-blocking). If this fails, some other
 *      session already holds it — that run is still active — skip.
 *   2. If acquired, ALSO check `pg_stat_activity` for any OTHER connection
 *      to that database (belt-and-suspenders beyond the lock alone — a
 *      client that connected directly to the target database without
 *      going through this module's own lock-holding connection would show
 *      up here even though it doesn't hold the lock). Any such connection
 *      means skip, not terminate.
 *   3. Only once BOTH checks pass — lock acquirable AND zero other
 *      connections — is the database eligible, and only then does age
 *      apply, as a short additional grace period
 *      (`STALE_DATABASE_MIN_AGE_MS`) absorbing the narrow window between
 *      `CREATE DATABASE` and the owner's own lock acquisition a few lines
 *      later — never as the primary or sole staleness signal.
 *   4. The probe connection HOLDS the lock through the actual existence
 *      re-check and `pg_terminate_backend`/`DROP DATABASE` steps (issued
 *      from that same connection, not released and re-acquired) — closing
 *      the check-then-act race a second concurrent sweeper could otherwise
 *      exploit between "determined eligible" and "actually dropped".
 *
 *      Two sweepers racing the same stale candidate do NOT always resolve
 *      to "only one ever acquires the lock" — `pg_try_advisory_lock` is
 *      session-scoped and released the instant the winning sweeper's probe
 *      connection ends (point 5 below), which can happen well before a
 *      slower second sweeper even reaches this candidate in its own loop.
 *      The second sweeper CAN legitimately acquire the lock afterward —
 *      what must never happen is the second sweeper CREDITING ITSELF with
 *      a drop it did not perform. That is why, immediately after acquiring
 *      the lock (and confirming no other connection is present), this
 *      function re-checks `pg_database` for the candidate's existence
 *      ONE more time before touching it: if a concurrent sweeper already
 *      removed it in the interim, this check sees it gone and the
 *      candidate is skipped — `DROP DATABASE IF EXISTS` is still issued
 *      defensively when the database IS found to exist (belt-and-suspenders
 *      against an even later removal within this same lock hold), but
 *      the return value's `datname` entry is only ever added when THIS
 *      invocation's own pre-drop existence check found a real row to
 *      remove — never merely because a DROP statement returned without
 *      error, since `DROP DATABASE IF EXISTS` succeeds silently as a
 *      no-op against an already-absent database.
 *   5. The throwaway probe connection is always closed after each
 *      candidate (releasing whatever lock it may have acquired), whether
 *      or not that candidate was ultimately (or already) dropped.
 */
export async function dropStaleDisposableDatabases(
  adminConnectionUrl: string,
): Promise<string[]> {
  assertTestPurgeAllowed("Refusing to sweep stale test databases");
  assertDatabaseTargetIsSafe(
    adminConnectionUrl,
    "Refusing to sweep stale test databases",
  );

  const adminUrl = new URL(adminConnectionUrl);
  const maintenanceUrl = maintenanceUrlFor(adminUrl);
  const admin = new pg.Client({ connectionString: maintenanceUrl });
  await admin.connect();
  const dropped: string[] = [];
  try {
    const { rows } = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'noahark_test_%'",
    );
    const now = Date.now();
    for (const { datname } of rows) {
      if (!isRecognizedTestDatabaseName(datname)) continue;

      const epochMatch = /_(\d+)_[0-9a-f]{8}$/.exec(datname);
      const createdAt = epochMatch ? Number(epochMatch[1]) : 0;
      if (now - createdAt < STALE_DATABASE_MIN_AGE_MS) continue;

      // Held for the FULL duration of this candidate's check-and-drop, not
      // released between "determined eligible" and "actually dropped" —
      // see this function's own doc comment, point 4.
      const probe = new pg.Client({ connectionString: maintenanceUrl });
      await probe.connect();
      try {
        const { rows: lockRows } = await probe.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
          [datname],
        );
        if (!lockRows[0]?.acquired) continue; // another session owns this run — active

        const { rows: activityRows } = await probe.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = $1",
          [datname],
        );
        if (Number(activityRows[0]?.count ?? "0") !== 0) continue; // someone connected directly

        // Revalidate existence under the lock, immediately before acting —
        // a concurrent sweeper may have already found this SAME candidate
        // eligible and dropped it between our initial SELECT snapshot and
        // this point (it can legitimately have acquired this lock after
        // that sweeper released it — see this function's own doc comment,
        // point 4). If the database is already gone, this invocation did
        // not drop it and must not report it as dropped.
        const { rows: existsRows } = await probe.query<{ exists: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
          [datname],
        );
        if (!existsRows[0]?.exists) continue; // already removed by a concurrent sweeper

        await probe.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [datname],
        );
        // Still IF EXISTS defensively (a database could theoretically be
        // removed by something outside this locking protocol between the
        // existence check above and here), but the result we report is
        // gated on OUR OWN existence check just above, not on this
        // statement completing without error — see point 4.
        await probe.query(`DROP DATABASE IF EXISTS ${probe.escapeIdentifier(datname)}`);
        dropped.push(datname);
      } finally {
        // Ending this connection releases whatever advisory lock it holds
        // (session-scoped) — no separate pg_advisory_unlock call needed.
        await probe.end();
      }
    }
  } finally {
    await admin.end();
  }
  return dropped;
}

export interface DisposableTestDatabase {
  name: string;
  /** Owner/admin connection scoped to this database — used only by test
   * fixtures via the system client, mirroring how the shared dev database's
   * DATABASE_MIGRATION_URL is used today. */
  migrationUrl: string;
  appUrl: string;
  workerUrl: string;
  /** Connects to the server's `postgres` maintenance database — required to
   * DROP this database later (a connection cannot drop the database it is
   * currently connected to). */
  maintenanceUrl: string;
  /** P1G-8 (Phase 1H): the dedicated admin connection holding this
   * database's session-level advisory lock for the whole run — see
   * `dropStaleDisposableDatabases`'s doc comment. Connected to the
   * `postgres` maintenance database (never to `name` itself), so it is
   * unaffected by `pg_terminate_backend(...) WHERE datname = $1` against
   * the disposable database. Not meant to be used for anything else;
   * `dropDisposableTestDatabase` ends it (releasing the lock) as its own
   * first step. If this process crashes before teardown runs, PostgreSQL
   * closes the connection and releases the lock automatically — no manual
   * recovery needed, which is exactly what lets a later sweep detect
   * abandonment. */
  lockClient: pg.Client;
}

/**
 * Creates a fresh, uniquely-named database on the SAME server the caller's
 * `adminConnectionUrl` points at (that URL is used only as the admin/owner
 * credential and connection target — its own database name and any rows in
 * it are never touched), provisions the `noahark_app`/`noahark_worker`
 * roles against it (idempotent — CREATE ROLE is cluster-wide, so a role
 * that already exists on the server just gets its non-secret attributes
 * re-asserted; GRANT CONNECT/USAGE are per-database and do run fresh here),
 * and applies every migration. Sweeps stale disposable databases from
 * abandoned prior runs first.
 */
export async function createDisposableTestDatabase(
  label: string,
  adminConnectionUrl: string,
): Promise<DisposableTestDatabase> {
  assertTestPurgeAllowed("Refusing to create a disposable test database");
  assertDatabaseTargetIsSafe(
    adminConnectionUrl,
    "Refusing to create a disposable test database",
  );

  await dropStaleDisposableDatabases(adminConnectionUrl);

  const adminUrl = new URL(adminConnectionUrl);
  const safeLabel = label.replace(/[^a-z0-9]/gi, "").toLowerCase() || "run";
  const name = `noahark_test_${safeLabel}_${Date.now()}_${randomBytes(4).toString("hex")}`;

  const maintenanceUrl = maintenanceUrlFor(adminUrl);
  const admin = new pg.Client({ connectionString: maintenanceUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)}`);
  } finally {
    await admin.end();
  }

  // P1G-8 (Phase 1H): acquire this database's advisory lock on a NEW,
  // dedicated connection, opened immediately after CREATE DATABASE and
  // held for the remainder of this function's caller's run — see
  // DisposableTestDatabase.lockClient's doc comment and
  // dropStaleDisposableDatabases's doc comment for the full mechanism.
  // pg_advisory_lock (blocking form) is safe to use here: nothing else
  // could already hold this exact key, since `name` was just generated
  // with a fresh random suffix a few lines above and this is the very
  // first attempt to lock it.
  const lockClient = new pg.Client({ connectionString: maintenanceUrl });
  await lockClient.connect();
  await lockClient.query("SELECT pg_advisory_lock(hashtext($1))", [name]);

  try {
    const migrationUrl = urlForDatabase(
      adminUrl,
      name,
      adminUrl.username,
      adminUrl.password,
    );
    const env = { ...process.env, DATABASE_MIGRATION_URL: migrationUrl };

    const provision = spawnSync(
      process.execPath,
      [path.join(DB_PACKAGE_DIR, "provisioning", "provision-roles.mjs")],
      { cwd: DB_PACKAGE_DIR, env, encoding: "utf8" },
    );
    if (provision.status !== 0) {
      throw new Error(
        `Disposable test database "${name}" provisioning failed (exit ${provision.status}):\n${provision.stdout}\n${provision.stderr}`,
      );
    }

    const migrate = spawnSync("npx", ["prisma", "migrate", "deploy"], {
      cwd: DB_PACKAGE_DIR,
      env,
      shell: true,
      encoding: "utf8",
    });
    if (migrate.status !== 0) {
      throw new Error(
        `Disposable test database "${name}" migration failed (exit ${migrate.status}):\n${migrate.stdout}\n${migrate.stderr}`,
      );
    }

    const appPassword = process.env.NOAHARK_APP_DB_PASSWORD ?? "noahark_app";
    const workerPassword = process.env.NOAHARK_WORKER_DB_PASSWORD ?? "noahark_worker";

    return {
      name,
      migrationUrl,
      appUrl: urlForDatabase(adminUrl, name, "noahark_app", appPassword),
      workerUrl: urlForDatabase(adminUrl, name, "noahark_worker", workerPassword),
      maintenanceUrl,
      lockClient,
    };
  } catch (e) {
    // Provisioning/migration failed after the lock was acquired — release
    // it and close the connection so a later sweep can still recognize
    // this half-created database as abandoned rather than leaking a
    // permanently-locked, never-returned handle.
    await lockClient.end();
    throw e;
  }
}

/**
 * Releases this database's advisory lock, terminates any remaining
 * connections, and drops the database. Idempotent (IF EXISTS) — safe to
 * call even if creation partially failed.
 *
 * P1G-8 (Phase 1H): `db.lockClient` (if present — optional so a caller
 * that only has `{ name, maintenanceUrl }`, e.g. from a stale-database
 * listing rather than a live `DisposableTestDatabase`, can still call
 * this) is ended FIRST, before terminating other backends — ending it
 * releases this run's own hold on the advisory lock and its own
 * connection together, so it is not mistaken for a "remaining connection"
 * by the `pg_terminate_backend` step (which connects to `datname`, not
 * `postgres`, and so would not have touched `lockClient` anyway, but
 * releasing our own lock explicitly, in order, keeps the sequence
 * unambiguous rather than relying on that separation).
 */
export async function dropDisposableTestDatabase(
  db: Pick<DisposableTestDatabase, "name" | "maintenanceUrl"> &
    Partial<Pick<DisposableTestDatabase, "lockClient">>,
): Promise<void> {
  assertTestPurgeAllowed("Refusing to drop a disposable test database");
  if (!isRecognizedTestDatabaseName(db.name)) {
    throw new Error(
      `Refusing to drop database "${db.name}" — its name does not match this module's own ` +
        `disposable-test-database pattern, so it was not (verifiably) created by this module.`,
    );
  }
  if (db.lockClient) {
    await db.lockClient.end();
  }
  const admin = new pg.Client({ connectionString: db.maintenanceUrl });
  await admin.connect();
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [db.name],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(db.name)}`);
  } finally {
    await admin.end();
  }
}
