import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import {
  dropStaleDisposableDatabases,
  isRecognizedTestDatabaseName,
} from "../testDbLifecycle";

/**
 * P1G-8 (Phase 1H): live proof that `dropStaleDisposableDatabases` decides
 * staleness by advisory-lock ownership + live connections, not by age
 * alone. Runs against the SAME PostgreSQL server the current integration
 * suite's own disposable database lives on (`process.env
 * .DATABASE_MIGRATION_URL`'s host/port/credentials — its own `pathname`
 * doesn't matter, since every helper here immediately re-derives `/postgres`
 * or a fresh candidate name, exactly like `testDbLifecycle.ts` itself does).
 *
 * Every candidate database name embeds its own (possibly artificially
 * backdated) creation epoch directly in the name — `dropStaleDisposableDatabases`
 * parses age from the NAME, not from real wall-clock elapsed time, so a
 * "2 hours old" scenario needs no actual waiting; it just needs a name
 * whose embedded epoch is old.
 */
function adminUrl(): string {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error("DATABASE_MIGRATION_URL is not set");
  return url;
}

function maintenanceUrl(): string {
  const u = new URL(adminUrl());
  u.pathname = "/postgres";
  return u.toString();
}

function candidateName(tag: string, ageMs = 0): string {
  const epoch = Date.now() - ageMs;
  const safeTag = tag.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return `noahark_test_own${safeTag}_${epoch}_${randomBytes(4).toString("hex")}`;
}

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: maintenanceUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function createRawCandidate(name: string): Promise<void> {
  await withAdmin((admin) =>
    admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)}`),
  );
}

async function dropRawCandidateIfExists(name: string): Promise<void> {
  await withAdmin(async (admin) => {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)}`);
  });
}

async function databaseExists(name: string): Promise<boolean> {
  return withAdmin(async (admin) => {
    const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      name,
    ]);
    return rows.length > 0;
  });
}

/** Opens a dedicated connection and holds `name`'s advisory lock —
 * simulates `createDisposableTestDatabase`'s own lock-holding connection
 * for an "active run", without paying for a full provision+migrate cycle. */
async function acquireLock(name: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: maintenanceUrl() });
  await client.connect();
  await client.query("SELECT pg_advisory_lock(hashtext($1))", [name]);
  return client;
}

describe("dropStaleDisposableDatabases — ownership-based staleness (P1G-8)", () => {
  const createdRawNames: string[] = [];
  const openLockClients: pg.Client[] = [];

  afterEach(async () => {
    for (const client of openLockClients.splice(0)) {
      await client.end().catch(() => undefined);
    }
    for (const name of createdRawNames.splice(0)) {
      await dropRawCandidateIfExists(name).catch(() => undefined);
    }
  });

  it("an active database with a recent name survives a sweep", async () => {
    const name = candidateName("activeyoung", 0);
    createdRawNames.push(name);
    await createRawCandidate(name);
    const lock = await acquireLock(name);
    openLockClients.push(lock);

    await dropStaleDisposableDatabases(adminUrl());

    expect(await databaseExists(name)).toBe(true);
  });

  it("an active database with an OLD embedded name still survives — age alone is never sufficient", async () => {
    const name = candidateName("activeold", 3 * 60 * 60 * 1000); // 3 hours old by name
    createdRawNames.push(name);
    await createRawCandidate(name);
    const lock = await acquireLock(name);
    openLockClients.push(lock);

    await dropStaleDisposableDatabases(adminUrl());

    expect(await databaseExists(name)).toBe(true);
  });

  it("an inactive, old, unlocked database is removed", async () => {
    const name = candidateName("stale", 3 * 60 * 60 * 1000);
    createdRawNames.push(name);
    await createRawCandidate(name);
    // No lock acquired, no connections held — genuinely abandoned.

    await dropStaleDisposableDatabases(adminUrl());

    expect(await databaseExists(name)).toBe(false);
  });

  it("two concurrent active runs both survive the same sweep", async () => {
    const nameA = candidateName("concurrenta", 3 * 60 * 60 * 1000);
    const nameB = candidateName("concurrentb", 3 * 60 * 60 * 1000);
    createdRawNames.push(nameA, nameB);
    await createRawCandidate(nameA);
    await createRawCandidate(nameB);
    const lockA = await acquireLock(nameA);
    const lockB = await acquireLock(nameB);
    openLockClients.push(lockA, lockB);

    await dropStaleDisposableDatabases(adminUrl());

    expect(await databaseExists(nameA)).toBe(true);
    expect(await databaseExists(nameB)).toBe(true);
  });

  it("a crashed owner (lock connection closed without dropping) becomes eligible for later cleanup", async () => {
    const name = candidateName("crashed", 3 * 60 * 60 * 1000);
    createdRawNames.push(name);
    await createRawCandidate(name);
    const lock = await acquireLock(name);
    // Simulate the owning process crashing: end the connection directly,
    // never calling dropDisposableTestDatabase. PostgreSQL releases the
    // session-level advisory lock automatically.
    await lock.end();

    await dropStaleDisposableDatabases(adminUrl());

    expect(await databaseExists(name)).toBe(false);
  });

  it("two concurrent sweepers racing the same stale database do not error and drop it exactly once, and a later sweep is idempotent", async () => {
    const name = candidateName("race", 3 * 60 * 60 * 1000);
    createdRawNames.push(name);
    await createRawCandidate(name);

    const results = await Promise.allSettled([
      dropStaleDisposableDatabases(adminUrl()),
      dropStaleDisposableDatabases(adminUrl()),
    ]);
    for (const result of results) {
      expect(result.status).toBe("fulfilled");
    }
    expect(await databaseExists(name)).toBe(false);

    const droppedBy = (results as PromiseFulfilledResult<string[]>[]).map((r) =>
      r.value.includes(name),
    );
    // Exactly one sweeper's result should credit itself with dropping it.
    // The advisory lock does NOT guarantee only one sweeper ever acquires
    // it — `pg_try_advisory_lock` is released the moment the winning
    // sweeper's probe connection ends, which can happen before a slower
    // second sweeper even reaches this candidate in its own loop, so the
    // second sweeper CAN legitimately acquire the lock afterward. What
    // guarantees exactly one true here is that the loser, upon acquiring
    // the lock, re-checks the database's existence immediately before
    // acting and finds it already gone — see `dropStaleDisposableDatabases`'s
    // own doc comment, point 4, for the full mechanism.
    expect(droppedBy.filter(Boolean).length).toBe(1);

    // A later sweep — run after both concurrent sweepers above have fully
    // resolved — must see the same candidate name as already absent and
    // must not report a drop for it a second (or third) time.
    const laterSweepResult = await dropStaleDisposableDatabases(adminUrl());
    expect(laterSweepResult.includes(name)).toBe(false);
    expect(await databaseExists(name)).toBe(false);
  });

  it("never touches the shared development database regardless of name", async () => {
    // "noahark" (the real shared dev database name) never matches
    // TEST_DATABASE_NAME_PATTERN — proven structurally, no live database
    // named that needs to exist for this assertion to be meaningful.
    expect(isRecognizedTestDatabaseName("noahark")).toBe(false);
  });

  it("never touches a database whose name merely resembles the pattern", async () => {
    const almostName = `noahark_test_${randomBytes(4).toString("hex")}`; // missing the epoch/suffix segments
    createdRawNames.push(almostName);
    await createRawCandidate(almostName);

    await dropStaleDisposableDatabases(adminUrl());

    expect(await databaseExists(almostName)).toBe(true);
  });

  it("refuses to sweep against a production-looking admin connection", async () => {
    await expect(
      dropStaleDisposableDatabases(
        "postgresql://user:pass@my-db.postgres.database.azure.com:5432/noahark",
      ),
    ).rejects.toThrow(/looks like a production target/);
  });
});
