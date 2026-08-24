import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import pg from "pg";
import { createSystemClient } from "@noahark/db/system";
import { getWorkerClient } from "@noahark/db/worker";
import { cleanupTerminalJobs, cleanupTerminalOutboxEvents } from "@noahark/jobs";
import { setupTestTenant, cleanupTenant, cleanupUser } from "./testHelpers";

/**
 * Phase 1H.1: worker-DELETE-hardening adversarial live probes, proving the
 * retention boundary is enforced BY THE DATABASE — status, batch size, AND
 * the minimum-retention-age floor — not merely by
 * `cleanupTerminalJobs`/`cleanupTerminalOutboxEvents`'s own TypeScript
 * argument defaults. Every test in the "direct role" sections below calls
 * `worker_cleanup_terminal_jobs`/`worker_cleanup_terminal_outbox_events`
 * directly as `noahark_worker`, via raw SQL, bypassing the TypeScript
 * wrapper entirely — proving the boundary holds even for a compromised or
 * independently-invoked worker. See the RLS migration
 * (packages/db/prisma/migrations/20260817000002_rls_and_constraints/migration.sql)
 * for the function bodies and the full investigation this test suite
 * verifies.
 */
async function directWorkerCall(
  fn: "worker_cleanup_terminal_jobs" | "worker_cleanup_terminal_outbox_events",
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  const worker = getWorkerClient();
  const rows = await worker.$queryRawUnsafe<Array<{ deleted_count: number }>>(
    `SELECT deleted_count FROM ${fn}($1, $2)`,
    cutoff,
    batchSize,
  );
  return rows[0]?.deleted_count ?? 0;
}

describe("background_job — worker DELETE hardening (Phase 1H.1)", () => {
  it("noahark_worker cannot issue a raw DELETE at all — the grant is gone", async () => {
    const worker = getWorkerClient();
    await expect(
      worker.$executeRawUnsafe("DELETE FROM background_job WHERE 1=0"),
    ).rejects.toThrow(/permission denied/i);
  });

  it("PENDING jobs are never eligible, even called directly as the worker role with cutoff=far future", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const pending = await system.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.pending_guard",
        payload: {},
        status: "PENDING",
      },
    });

    await directWorkerCall(
      "worker_cleanup_terminal_jobs",
      new Date("9999-01-01T00:00:00Z"),
      500,
    );

    expect(
      await system.backgroundJob.findUnique({ where: { id: pending.id } }),
    ).not.toBeNull();
    await system.backgroundJob.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("PROCESSING jobs are never eligible, even called directly as the worker role", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const processing = await system.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.processing_guard",
        payload: {},
        status: "PROCESSING",
      },
    });

    await directWorkerCall(
      "worker_cleanup_terminal_jobs",
      new Date("9999-01-01T00:00:00Z"),
      500,
    );

    expect(
      await system.backgroundJob.findUnique({ where: { id: processing.id } }),
    ).not.toBeNull();
    await system.backgroundJob.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("a recently terminal SUCCEEDED job survives even a direct call with cutoff=now()", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const recent = await system.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.recent_succeeded_guard",
        payload: {},
        status: "SUCCEEDED",
      },
    });

    await directWorkerCall("worker_cleanup_terminal_jobs", new Date(), 500);

    expect(
      await system.backgroundJob.findUnique({ where: { id: recent.id } }),
    ).not.toBeNull();
    await system.backgroundJob.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("a recently terminal FAILED job survives — status is never eligible under the current function, even though JobStatus.FAILED exists in the schema", async () => {
    // JobStatus.FAILED is declared in the schema but never actually set by
    // any code path today (failJob only ever writes PENDING or DEAD) —
    // inserted directly via raw SQL here to prove the function's own
    // status filter (SUCCEEDED/DEAD only) would still protect it even if
    // a future code path, or manual intervention, ever produced one.
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const recent = await system.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO background_job (id, tenant_id, job_type, payload, status, updated_at, created_at, run_at)
       VALUES ($1, $2, 'test.recent_failed_guard', '{}'::jsonb, 'FAILED', now(), now(), now())
       RETURNING id`,
      randomUUID(),
      setup.tenantId,
    );

    await directWorkerCall(
      "worker_cleanup_terminal_jobs",
      new Date("9999-01-01T00:00:00Z"),
      500,
    );

    expect(
      await system.backgroundJob.findUnique({ where: { id: recent[0]!.id } }),
    ).not.toBeNull();
    await system.backgroundJob.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("a recently terminal DEAD job survives even a direct call with cutoff=now()", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const recent = await system.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.recent_dead_guard",
        payload: {},
        status: "DEAD",
      },
    });

    await directWorkerCall("worker_cleanup_terminal_jobs", new Date(), 500);

    expect(
      await system.backgroundJob.findUnique({ where: { id: recent.id } }),
    ).not.toBeNull();
    await system.backgroundJob.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("an old eligible terminal job IS removed by a direct role call — hardening does not break legitimate cleanup", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const oldDead = await system.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.old_dead_guard",
        payload: {},
        status: "DEAD",
      },
    });
    await system.backgroundJob.update({
      where: { id: oldDead.id },
      data: { updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    });

    const removed = await directWorkerCall(
      "worker_cleanup_terminal_jobs",
      new Date(),
      500,
    );

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(
      await system.backgroundJob.findUnique({ where: { id: oldDead.id } }),
    ).toBeNull();
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("a worker-supplied future cutoff cannot bypass the database's minimum-retention floor", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const fresh = await system.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.future_cutoff_guard",
        payload: {},
        status: "SUCCEEDED",
      },
    });

    await directWorkerCall(
      "worker_cleanup_terminal_jobs",
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      500,
    );

    expect(
      await system.backgroundJob.findUnique({ where: { id: fresh.id } }),
    ).not.toBeNull();
    await system.backgroundJob.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("a worker-supplied extreme cutoff (year 9999) cannot bypass the database's minimum-retention floor", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const fresh = await system.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.extreme_cutoff_guard",
        payload: {},
        status: "SUCCEEDED",
      },
    });

    await directWorkerCall(
      "worker_cleanup_terminal_jobs",
      new Date("9999-01-01T00:00:00Z"),
      500,
    );

    expect(
      await system.backgroundJob.findUnique({ where: { id: fresh.id } }),
    ).not.toBeNull();
    await system.backgroundJob.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("a worker-supplied batch_size cannot exceed the database's 1000-row cap", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const oldTimestamp = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Bulk-insert 1005 old, eligible DEAD jobs in one round trip.
    await system.$executeRawUnsafe(
      `INSERT INTO background_job (id, tenant_id, job_type, payload, status, updated_at, created_at, run_at)
       SELECT gen_random_uuid()::text, $1, 'test.batch_cap_guard', '{}'::jsonb, 'DEAD', $2, $2, $2
       FROM generate_series(1, 1005)`,
      setup.tenantId,
      oldTimestamp,
    );

    const removedFirst = await directWorkerCall(
      "worker_cleanup_terminal_jobs",
      new Date(),
      999999, // hostile: requests far more than the database cap
    );
    expect(removedFirst).toBe(1000);

    const remaining = await system.backgroundJob.count({
      where: { tenantId: setup.tenantId, jobType: "test.batch_cap_guard" },
    });
    expect(remaining).toBe(5);

    const removedSecond = await directWorkerCall(
      "worker_cleanup_terminal_jobs",
      new Date(),
      999999,
    );
    expect(removedSecond).toBe(5);

    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  }, 30_000);

  it("concurrent cleanup calls never delete PENDING, PROCESSING, or recently-terminal records", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const pending = await system.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.concurrent_pending",
        payload: {},
        status: "PENDING",
      },
    });
    const recent = await system.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.concurrent_recent",
        payload: {},
        status: "SUCCEEDED",
      },
    });
    const old = await system.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.concurrent_old",
        payload: {},
        status: "DEAD",
      },
    });
    await system.backgroundJob.update({
      where: { id: old.id },
      data: { updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    });

    await Promise.all([
      directWorkerCall("worker_cleanup_terminal_jobs", new Date(), 500),
      directWorkerCall("worker_cleanup_terminal_jobs", new Date(), 500),
      directWorkerCall("worker_cleanup_terminal_jobs", new Date(), 500),
    ]);

    expect(
      await system.backgroundJob.findUnique({ where: { id: pending.id } }),
    ).not.toBeNull();
    expect(
      await system.backgroundJob.findUnique({ where: { id: recent.id } }),
    ).not.toBeNull();
    expect(await system.backgroundJob.findUnique({ where: { id: old.id } })).toBeNull();

    await system.backgroundJob.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("repeated cleanup calls are idempotent — a second call finds nothing left to remove", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const old = await system.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.idempotent_guard",
        payload: {},
        status: "DEAD",
      },
    });
    await system.backgroundJob.update({
      where: { id: old.id },
      data: { updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    });

    const first = await directWorkerCall("worker_cleanup_terminal_jobs", new Date(), 500);
    const second = await directWorkerCall(
      "worker_cleanup_terminal_jobs",
      new Date(),
      500,
    );
    expect(first).toBeGreaterThanOrEqual(1);
    expect(second).toBe(0);

    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("the TypeScript wrapper (cleanupTerminalJobs) still works end to end", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const oldDead = await system.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.wrapper_e2e_guard",
        payload: {},
        status: "DEAD",
      },
    });
    await system.backgroundJob.update({
      where: { id: oldDead.id },
      data: { updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    });
    const recent = await system.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.wrapper_e2e_recent",
        payload: {},
        status: "SUCCEEDED",
      },
    });

    const removed = await cleanupTerminalJobs(Date.now());
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(
      await system.backgroundJob.findUnique({ where: { id: oldDead.id } }),
    ).toBeNull();
    expect(
      await system.backgroundJob.findUnique({ where: { id: recent.id } }),
    ).not.toBeNull();

    await system.backgroundJob.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("noahark_worker cannot delete an ordinary tenant-owned business record at all", async () => {
    const worker = getWorkerClient();
    await expect(
      worker.$executeRawUnsafe("DELETE FROM tenant WHERE 1=0"),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("outbox_event — worker DELETE hardening (Phase 1H.1)", () => {
  it("noahark_worker cannot issue a raw DELETE at all — the grant is gone", async () => {
    const worker = getWorkerClient();
    await expect(
      worker.$executeRawUnsafe("DELETE FROM outbox_event WHERE 1=0"),
    ).rejects.toThrow(/permission denied/i);
  });

  it("PENDING events are never eligible, even called directly with an extreme cutoff", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const pending = await system.outboxEvent.create({
      data: {
        tenantId: setup.tenantId,
        eventType: "test.pending_outbox_guard",
        payload: {},
      },
    });

    await directWorkerCall(
      "worker_cleanup_terminal_outbox_events",
      new Date("9999-01-01T00:00:00Z"),
      500,
    );

    expect(
      await system.outboxEvent.findUnique({ where: { id: pending.id } }),
    ).not.toBeNull();
    await system.outboxEvent.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("PROCESSING events are never eligible", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const processing = await system.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO outbox_event (id, tenant_id, event_type, payload, status, created_at)
       VALUES ($1, $2, 'test.processing_outbox_guard', '{}'::jsonb, 'PROCESSING', now())
       RETURNING id`,
      randomUUID(),
      setup.tenantId,
    );

    await directWorkerCall(
      "worker_cleanup_terminal_outbox_events",
      new Date("9999-01-01T00:00:00Z"),
      500,
    );

    expect(
      await system.outboxEvent.findUnique({ where: { id: processing[0]!.id } }),
    ).not.toBeNull();
    await system.outboxEvent.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("a recently terminal PROCESSED event survives even a direct call with cutoff=now()", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const recent = await system.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO outbox_event (id, tenant_id, event_type, payload, status, created_at, processed_at)
       VALUES ($1, $2, 'test.recent_processed_guard', '{}'::jsonb, 'PROCESSED', now(), now())
       RETURNING id`,
      randomUUID(),
      setup.tenantId,
    );

    await directWorkerCall("worker_cleanup_terminal_outbox_events", new Date(), 500);

    expect(
      await system.outboxEvent.findUnique({ where: { id: recent[0]!.id } }),
    ).not.toBeNull();
    await system.outboxEvent.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("a recently terminal FAILED event survives even a direct call with cutoff=now()", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const recent = await system.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO outbox_event (id, tenant_id, event_type, payload, status, created_at)
       VALUES ($1, $2, 'test.recent_failed_outbox_guard', '{}'::jsonb, 'FAILED', now())
       RETURNING id`,
      randomUUID(),
      setup.tenantId,
    );

    await directWorkerCall("worker_cleanup_terminal_outbox_events", new Date(), 500);

    expect(
      await system.outboxEvent.findUnique({ where: { id: recent[0]!.id } }),
    ).not.toBeNull();
    await system.outboxEvent.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("an old eligible terminal event IS removed by a direct role call", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const oldProcessed = await system.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO outbox_event (id, tenant_id, event_type, payload, status, created_at, processed_at)
       VALUES ($1, $2, 'test.old_processed_guard', '{}'::jsonb, 'PROCESSED', $3, $3)
       RETURNING id`,
      randomUUID(),
      setup.tenantId,
      new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    );

    const removed = await directWorkerCall(
      "worker_cleanup_terminal_outbox_events",
      new Date(),
      500,
    );

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(
      await system.outboxEvent.findUnique({ where: { id: oldProcessed[0]!.id } }),
    ).toBeNull();
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("a worker-supplied future/extreme cutoff cannot bypass the database's minimum-retention floor", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const fresh = await system.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO outbox_event (id, tenant_id, event_type, payload, status, created_at, processed_at)
       VALUES ($1, $2, 'test.future_cutoff_outbox_guard', '{}'::jsonb, 'PROCESSED', now(), now())
       RETURNING id`,
      randomUUID(),
      setup.tenantId,
    );

    await directWorkerCall(
      "worker_cleanup_terminal_outbox_events",
      new Date("9999-01-01T00:00:00Z"),
      500,
    );

    expect(
      await system.outboxEvent.findUnique({ where: { id: fresh[0]!.id } }),
    ).not.toBeNull();
    await system.outboxEvent.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("a worker-supplied batch_size cannot exceed the database's 1000-row cap", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const oldTimestamp = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    await system.$executeRawUnsafe(
      `INSERT INTO outbox_event (id, tenant_id, event_type, payload, status, created_at, processed_at)
       SELECT gen_random_uuid()::text, $1, 'test.batch_cap_outbox_guard', '{}'::jsonb, 'PROCESSED', $2, $2
       FROM generate_series(1, 1005)`,
      setup.tenantId,
      oldTimestamp,
    );

    const removedFirst = await directWorkerCall(
      "worker_cleanup_terminal_outbox_events",
      new Date(),
      999999,
    );
    expect(removedFirst).toBe(1000);

    const remaining = await system.outboxEvent.count({
      where: { tenantId: setup.tenantId, eventType: "test.batch_cap_outbox_guard" },
    });
    expect(remaining).toBe(5);

    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  }, 30_000);

  it("concurrent cleanup calls never delete PENDING or recently-terminal events", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const pending = await system.outboxEvent.create({
      data: {
        tenantId: setup.tenantId,
        eventType: "test.concurrent_pending_outbox",
        payload: {},
      },
    });
    const old = await system.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO outbox_event (id, tenant_id, event_type, payload, status, created_at, processed_at)
       VALUES ($1, $2, 'test.concurrent_old_outbox', '{}'::jsonb, 'PROCESSED', $3, $3)
       RETURNING id`,
      randomUUID(),
      setup.tenantId,
      new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    );

    await Promise.all([
      directWorkerCall("worker_cleanup_terminal_outbox_events", new Date(), 500),
      directWorkerCall("worker_cleanup_terminal_outbox_events", new Date(), 500),
      directWorkerCall("worker_cleanup_terminal_outbox_events", new Date(), 500),
    ]);

    expect(
      await system.outboxEvent.findUnique({ where: { id: pending.id } }),
    ).not.toBeNull();
    expect(await system.outboxEvent.findUnique({ where: { id: old[0]!.id } })).toBeNull();

    await system.outboxEvent.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("repeated cleanup calls are idempotent", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    await system.$queryRawUnsafe(
      `INSERT INTO outbox_event (id, tenant_id, event_type, payload, status, created_at, processed_at)
       VALUES ($1, $2, 'test.idempotent_outbox_guard', '{}'::jsonb, 'PROCESSED', $3, $3)`,
      randomUUID(),
      setup.tenantId,
      new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    );

    const first = await directWorkerCall(
      "worker_cleanup_terminal_outbox_events",
      new Date(),
      500,
    );
    const second = await directWorkerCall(
      "worker_cleanup_terminal_outbox_events",
      new Date(),
      500,
    );
    expect(first).toBeGreaterThanOrEqual(1);
    expect(second).toBe(0);

    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("the TypeScript wrapper (cleanupTerminalOutboxEvents) still works end to end", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    await system.$queryRawUnsafe(
      `INSERT INTO outbox_event (id, tenant_id, event_type, payload, status, created_at, processed_at)
       VALUES ($1, $2, 'test.wrapper_e2e_outbox', '{}'::jsonb, 'PROCESSED', $3, $3)`,
      randomUUID(),
      setup.tenantId,
      new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    );

    const removed = await cleanupTerminalOutboxEvents(Date.now());
    expect(removed).toBeGreaterThanOrEqual(1);

    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });
});

describe("timezone independence (Phase 1H.1)", () => {
  const zones = ["UTC", "Asia/Singapore", "Etc/GMT+5"] as const;

  it("the same stored timestamps produce the same eligibility result under UTC, Asia/Singapore, and a negative-offset session timezone", async () => {
    const system = createSystemClient();
    const setup = await setupTestTenant();
    const fresh = await system.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.tz_fresh_guard",
        payload: {},
        status: "SUCCEEDED",
      },
    });
    const old = await system.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.tz_old_guard",
        payload: {},
        status: "DEAD",
      },
    });
    await system.backgroundJob.update({
      where: { id: old.id },
      data: { updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    });

    const results: Record<string, { fresh: boolean; old: boolean }> = {};
    for (const zone of zones) {
      const client = new pg.Client({ connectionString: process.env.DATABASE_WORKER_URL });
      await client.connect();
      try {
        await client.query(`SET TIME ZONE '${zone}'`);
        const cutoff = new Date();
        await client.query(
          `SELECT deleted_count FROM worker_cleanup_terminal_jobs($1, $2)`,
          [cutoff, 1],
        );
        // Re-check via the system client (not session-dependent) whether
        // each row survived THIS zone's cleanup pass.
        const freshRow = await system.backgroundJob.findUnique({
          where: { id: fresh.id },
        });
        const oldRow = await system.backgroundJob.findUnique({ where: { id: old.id } });
        results[zone] = { fresh: freshRow !== null, old: oldRow !== null };
        // Recreate the old row for the next zone's pass if it was removed.
        if (!oldRow) {
          const recreated = await system.backgroundJob.create({
            data: {
              tenantId: setup.tenantId,
              jobType: "test.tz_old_guard",
              payload: {},
              status: "DEAD",
            },
          });
          await system.backgroundJob.update({
            where: { id: recreated.id },
            data: { updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
          });
          old.id = recreated.id;
        }
      } finally {
        await client.end();
      }
    }

    for (const zone of zones) {
      expect(results[zone]?.fresh, `zone ${zone}: fresh survives`).toBe(true);
      expect(results[zone]?.old, `zone ${zone}: old removed`).toBe(false);
    }

    await system.backgroundJob.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });
});
