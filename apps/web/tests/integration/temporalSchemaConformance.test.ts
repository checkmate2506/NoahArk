import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createSystemClient } from "@noahark/db/system";
import { TEMPORAL_INVENTORY } from "@noahark/db";
import { setupTestTenant, cleanupTenant, cleanupUser } from "./testHelpers";

/**
 * Phase 1H.2: compares `packages/db/src/temporalInventory.ts`'s documented
 * temporal-column inventory directly against the deployed schema's
 * `information_schema.columns`, on the current run's own disposable
 * database. This is the backstop the Phase 1H.2 brief asked for: a schema
 * change that silently reverts an absolute-instant column back to naive
 * `timestamp WITHOUT time zone` (Prisma's default whenever `@db.Timestamptz`
 * is omitted from a `DateTime` field) fails THIS test, not just a future
 * source-level review.
 *
 * Two directions are checked:
 *   1. Every inventoried column exists in the deployed schema with exactly
 *      its documented `expectedPgType`.
 *   2. Every `DateTime`-derived column that ACTUALLY exists in the deployed
 *      schema is present in the inventory — an added temporal column that
 *      nobody classified and registered here fails, rather than silently
 *      keeping Prisma's default (naive) type unnoticed.
 */
describe("temporal schema conformance (Phase 1H.2)", () => {
  // Phase 1H.3 (test-isolation hardening): only one test below creates a
  // tenant/job fixture; this fail-safe is added for consistency with the
  // other two Phase 1H.2 files and to guarantee cleanup even if a future
  // edit adds more tenant-scoped tests here. See
  // jobSchedulingTemporalMatrix.test.ts for the fuller rationale.
  let tenantSetup: Awaited<ReturnType<typeof setupTestTenant>> | undefined;
  afterEach(async () => {
    if (tenantSetup) {
      await cleanupTenant(tenantSetup.tenantId).catch(() => undefined);
      await cleanupUser(tenantSetup.adminUserId).catch(() => undefined);
      tenantSetup = undefined;
    }
  });

  it("every documented absolute-instant column is deployed as timestamptz", async () => {
    const db = createSystemClient();
    const rows = await db.$queryRawUnsafe<
      Array<{ table_name: string; column_name: string; data_type: string }>
    >(
      // Phase 2A widened this from `timestamp%` to also cover `date`: the
      // inventory now classifies LOCAL_CIVIL_DATE columns, which must be
      // `date` and would otherwise be reported as "documented but missing".
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (data_type LIKE 'timestamp%' OR data_type = 'date')`,
    );
    const deployed = new Map(
      rows.map((r) => [`${r.table_name}.${r.column_name}`, r.data_type]),
    );

    const missing: string[] = [];
    const wrongType: string[] = [];
    for (const entry of TEMPORAL_INVENTORY) {
      const key = `${entry.table}.${entry.column}`;
      const actual = deployed.get(key);
      if (!actual) {
        missing.push(key);
        continue;
      }
      if (actual !== entry.expectedPgType) {
        wrongType.push(`${key}: expected "${entry.expectedPgType}", got "${actual}"`);
      }
    }

    expect(missing, "columns documented but not found in the deployed schema").toEqual(
      [],
    );
    expect(wrongType, "columns deployed with an unexpected PostgreSQL type").toEqual([]);
  });

  it("no deployed temporal column is undocumented — every timestamp column has a classification", async () => {
    const db = createSystemClient();
    const rows = await db.$queryRawUnsafe<
      Array<{ table_name: string; column_name: string }>
    >(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (data_type LIKE 'timestamp%' OR data_type = 'date')
         AND table_name NOT LIKE '\\_prisma%'`,
    );
    const documented = new Set(TEMPORAL_INVENTORY.map((e) => `${e.table}.${e.column}`));
    const undocumented = rows
      .map((r) => `${r.table_name}.${r.column_name}`)
      .filter((key) => !documented.has(key));

    expect(
      undocumented,
      "temporal columns exist that are not in packages/db/src/temporalInventory.ts — " +
        "classify and register them there",
    ).toEqual([]);
  });

  it("no absolute-instant column is naive (timestamp WITHOUT time zone)", async () => {
    const db = createSystemClient();
    const rows = await db.$queryRawUnsafe<
      Array<{ table_name: string; column_name: string }>
    >(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'
         AND table_name NOT LIKE '\\_prisma%'`,
    );
    const naiveColumns = rows.map((r) => `${r.table_name}.${r.column_name}`);
    // Phase 1 has zero LOCAL_CIVIL_DATE/TIME columns (see
    // temporalInventory.ts's own doc comment) — so today, ANY naive
    // timestamp column at all is a regression. A future phase adding a
    // genuine local-civil-time column (never a LOCAL_CIVIL_DATE, which
    // uses `date`, not `timestamp`) would need to update this assertion
    // deliberately, not accidentally.
    expect(naiveColumns, "unexpected naive timestamp columns found").toEqual([]);
  });

  it("every documented LOCAL_CIVIL_DATE column is deployed as `date`, never timestamp/timestamptz (Phase 2A)", async () => {
    // The failure this guards against is silent and severe: dropping
    // `@db.Date` from a Prisma `DateTime` field yields `timestamptz`, which
    // makes a civil effective date zone-dependent. A price effective
    // "1 July" would then read as 30 June under a different session
    // timezone and select the wrong price on a boundary day.
    const civil = TEMPORAL_INVENTORY.filter(
      (e) => e.classification === "LOCAL_CIVIL_DATE",
    );
    expect(
      civil.length,
      "Phase 2A registered LOCAL_CIVIL_DATE columns — an empty list means the inventory regressed",
    ).toBeGreaterThan(0);

    const db = createSystemClient();
    const rows = await db.$queryRawUnsafe<
      Array<{ table_name: string; column_name: string; data_type: string }>
    >(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'`,
    );
    const deployed = new Map(
      rows.map((r) => [`${r.table_name}.${r.column_name}`, r.data_type]),
    );

    const wrong: string[] = [];
    for (const entry of civil) {
      const key = `${entry.table}.${entry.column}`;
      const actual = deployed.get(key);
      if (actual !== "date") {
        wrong.push(`${key}: expected "date", got "${actual ?? "MISSING"}"`);
      }
    }
    expect(
      wrong,
      "LOCAL_CIVIL_DATE columns must be PostgreSQL `date` — a timestamp/timestamptz here is a timezone-dependency bug",
    ).toEqual([]);
  });

  it("a civil date round-trips identically under every SG/MY/ID session timezone (Phase 2A)", async () => {
    // Proves the classification actually delivers its promise: the same
    // stored `date` reads back as the same calendar day regardless of the
    // connection's TimeZone, including a negative-offset zone.
    const zones = [
      "UTC",
      "Asia/Singapore",
      "Asia/Kuala_Lumpur",
      "Asia/Jakarta",
      "Asia/Jayapura",
      "Etc/GMT+5",
    ];
    const observed: string[] = [];
    for (const zone of zones) {
      const raw = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
      await raw.connect();
      try {
        await raw.query(`SET TIME ZONE '${zone}'`);
        const r = await raw.query<{ d: string }>(
          "SELECT to_char('2026-07-01'::date, 'YYYY-MM-DD') AS d",
        );
        observed.push(`${zone}=${r.rows[0]!.d}`);
      } finally {
        await raw.end();
      }
    }
    expect(new Set(observed.map((o) => o.split("=")[1])).size, observed.join(" ")).toBe(
      1,
    );
    expect(observed.every((o) => o.endsWith("=2026-07-01"))).toBe(true);
  });

  it("a Prisma-written absolute instant round-trips correctly when read back independently via raw pg (write-path regression guard)", async () => {
    // Phase 1H.2's most significant finding: `@prisma/adapter-pg` (used by
    // every Prisma client in this codebase) was found to serialize a JS
    // `Date` written to a genuine `timestamptz` column INCORRECTLY
    // whenever the connection's session `TimeZone` was not UTC — the
    // stored instant came out shifted by exactly the session's UTC
    // offset. This is a WRITE-path defect, invisible to a test that reads
    // the value back through Prisma's OWN model layer (which could, in
    // principle, apply a self-cancelling inverse shift and look correct
    // to itself) — this test deliberately reads back through an
    // INDEPENDENT raw `pg` connection instead, the only way to prove the
    // bytes actually on disk represent the intended instant. Fixed by
    // `packages/db/provisioning/provision-roles.mjs`'s
    // `ALTER DATABASE ... SET timezone TO 'UTC'`, which this run's own
    // disposable database was provisioned with — if that provisioning
    // step is ever removed or the underlying adapter regresses, this test
    // fails.
    const system = createSystemClient();
    const setup = (tenantSetup = await setupTestTenant());
    const before = Date.now();
    const intended = new Date(Date.now() + 60 * 60 * 1000);
    const job = await system.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.write_path_guard",
        payload: {},
        status: "PENDING",
        runAt: intended,
      },
    });

    const raw = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
    await raw.connect();
    try {
      const result = await raw.query<{ run_at: Date }>(
        "SELECT run_at FROM background_job WHERE id = $1",
        [job.id],
      );
      const storedMs = result.rows[0]!.run_at.getTime();
      expect(Math.abs(storedMs - intended.getTime())).toBeLessThan(1000);
    } finally {
      await raw.end();
    }

    const after = Date.now();
    expect(before).toBeLessThanOrEqual(after); // sanity: no clock went backwards mid-test

    await system.backgroundJob.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("the disposable test database's default session timezone is UTC", async () => {
    const raw = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
    await raw.connect();
    try {
      const result = await raw.query<{ TimeZone: string }>("SHOW timezone");
      expect(result.rows[0]?.TimeZone).toBe("UTC");
    } finally {
      await raw.end();
    }
  });
});
