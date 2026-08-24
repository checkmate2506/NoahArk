import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createSystemClient } from "@noahark/db/system";
import {
  claimNextJob,
  completeJob,
  failJob,
  heartbeatJob,
  reapExpiredJobLeases,
  claimNextOutboxEvent,
  heartbeatOutboxEvent,
  markOutboxProcessed,
  reapExpiredOutboxLeases,
  cleanupTerminalJobs,
  cleanupTerminalOutboxEvents,
} from "@noahark/jobs";
import { setupTestTenant, cleanupTenant, cleanupUser } from "./testHelpers";

/**
 * Phase 1H.2: job/outbox scheduling correctness AND timezone-independence,
 * following the schema-level fix (every temporal column in
 * `background_job`/`outbox_event` is now genuine `timestamptz` — see
 * `packages/db/src/temporalInventory.ts` and `queue.ts`'s own doc
 * comment). Two complementary proof strategies:
 *
 *   1. Tests that call the REAL exported functions
 *      (`claimNextJob`/`heartbeatJob`/`failJob`/`reapExpiredJobLeases`/
 *      etc.) directly, under this run's normal session — proves the
 *      actual application code is correct end to end.
 *   2. A parameterized matrix that opens a DEDICATED `noahark_worker`
 *      connection per PostgreSQL session timezone and issues the exact
 *      same SQL text `claimNextJob`/`heartbeatJob`/`reapExpiredJobLeases`
 *      use — proving the SQL itself carries no session-timezone
 *      dependency, which is the actual property that matters (a real
 *      deployment's pooled connections may end up with any session
 *      timezone; the query text itself, not this test file's own logic,
 *      is what must be timezone-safe).
 *
 * No real-time sleeps: every scenario controls its own timestamps via
 * direct fixture rows or explicit `run_at`/`lease_expires_at` values.
 */

const ZONES = [
  "UTC",
  "Asia/Singapore",
  "Asia/Kuala_Lumpur",
  "Asia/Jakarta",
  "Etc/GMT+5",
] as const;

async function withZoneWorkerConnection<T>(
  zone: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_WORKER_URL });
  await client.connect();
  try {
    await client.query(`SET TIME ZONE '${zone}'`);
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function insertJob(
  db: ReturnType<typeof createSystemClient>,
  tenantId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const job = await db.backgroundJob.create({
    data: {
      tenantId,
      jobType: "test.tz_matrix",
      payload: {},
      status: "PENDING",
      ...overrides,
    },
  });
  return job.id;
}

describe("job scheduling — timezone matrix (Phase 1H.2)", () => {
  // Phase 1H.3 (test-isolation hardening, following the Opus F-1 finding):
  // every test in this describe block assigns its tenant setup to this
  // SHARED variable instead of a local `const` — the `afterEach` below then
  // unconditionally cleans it up even when a `expect()` throws partway
  // through a test, so a mid-test assertion failure can never leave a
  // globally-claimable PENDING `background_job` row behind for an
  // unrelated LATER test file's own `claimNextJob()` call to pick up
  // (`claimNextJob` has no tenant/type filter by design — see queue.ts).
  // Each test's own pre-existing end-of-test cleanup calls are left in
  // place too; calling `cleanupTenant`/`cleanupUser` a second time for an
  // already-cleaned tenant is an established idempotent no-op elsewhere in
  // this codebase (see testHelpers.ts's own doc comments).
  let setup: Awaited<ReturnType<typeof setupTestTenant>> | undefined;
  afterEach(async () => {
    if (setup) {
      await cleanupTenant(setup.tenantId).catch(() => undefined);
      await cleanupUser(setup.adminUserId).catch(() => undefined);
      setup = undefined;
    }
  });

  describe.each(ZONES)("session timezone: %s", (zone) => {
    it("a job scheduled one hour in the future cannot be claimed", async () => {
      const system = createSystemClient();
      setup = await setupTestTenant();
      const jobId = await insertJob(system, setup.tenantId, {
        runAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      const claimed = await withZoneWorkerConnection(zone, (c) =>
        c.query(
          `UPDATE background_job
           SET status = 'PROCESSING', locked_at = now(), locked_by = 'zone-worker',
               lease_expires_at = now() + interval '60 seconds', heartbeat_at = now(),
               attempts = attempts + 1, updated_at = now()
           WHERE id = (
             SELECT id FROM background_job
             WHERE status = 'PENDING' AND run_at <= now() AND id = $1
             FOR UPDATE SKIP LOCKED LIMIT 1
           )
           RETURNING id`,
          [jobId],
        ),
      );

      expect(claimed.rows).toHaveLength(0);
      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
    });

    it("a job scheduled one second in the past can be claimed", async () => {
      const system = createSystemClient();
      setup = await setupTestTenant();
      const jobId = await insertJob(system, setup.tenantId, {
        runAt: new Date(Date.now() - 1000),
      });

      const claimed = await withZoneWorkerConnection(zone, (c) =>
        c.query(
          `UPDATE background_job
           SET status = 'PROCESSING', locked_at = now(), locked_by = 'zone-worker',
               lease_expires_at = now() + interval '60 seconds', heartbeat_at = now(),
               attempts = attempts + 1, updated_at = now()
           WHERE id = (
             SELECT id FROM background_job
             WHERE status = 'PENDING' AND run_at <= now() AND id = $1
             FOR UPDATE SKIP LOCKED LIMIT 1
           )
           RETURNING id`,
          [jobId],
        ),
      );

      expect(claimed.rows).toHaveLength(1);
      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
    });

    it("retry backoff prevents an immediate re-claim, and the job becomes claimable only after the backoff instant", async () => {
      const system = createSystemClient();
      setup = await setupTestTenant();
      // A job "failing" with a backoff delay of 2 seconds — run_at set
      // slightly in the future, exactly what failJob's retry path does.
      const jobId = await insertJob(system, setup.tenantId, {
        runAt: new Date(Date.now() + 2000),
      });

      const tooEarly = await withZoneWorkerConnection(zone, (c) =>
        c.query(
          `SELECT id FROM background_job WHERE status = 'PENDING' AND run_at <= now() AND id = $1`,
          [jobId],
        ),
      );
      expect(tooEarly.rows).toHaveLength(0);

      // Move run_at into the past (simulating time having elapsed past the
      // backoff instant) without any real sleep.
      await system.backgroundJob.update({
        where: { id: jobId },
        data: { runAt: new Date(Date.now() - 1) },
      });

      const nowEligible = await withZoneWorkerConnection(zone, (c) =>
        c.query(
          `SELECT id FROM background_job WHERE status = 'PENDING' AND run_at <= now() AND id = $1`,
          [jobId],
        ),
      );
      expect(nowEligible.rows).toHaveLength(1);

      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
    });

    it("lease expiry is identical across session timezones", async () => {
      const system = createSystemClient();
      setup = await setupTestTenant();
      const jobId = await insertJob(system, setup.tenantId, { status: "PROCESSING" });
      // Lease already expired 1 second ago.
      await system.backgroundJob.update({
        where: { id: jobId },
        data: { leaseExpiresAt: new Date(Date.now() - 1000) },
      });

      const expired = await withZoneWorkerConnection(zone, (c) =>
        c.query(
          `SELECT id FROM background_job WHERE status = 'PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at < now() AND id = $1`,
          [jobId],
        ),
      );
      expect(expired.rows).toHaveLength(1);

      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
    });

    it("heartbeat extension is identical across session timezones", async () => {
      const system = createSystemClient();
      setup = await setupTestTenant();
      const jobId = await insertJob(system, setup.tenantId, {
        status: "PROCESSING",
        lockedBy: "zone-worker",
      });

      const before = await system.backgroundJob.findUniqueOrThrow({
        where: { id: jobId },
      });
      const result = await withZoneWorkerConnection(zone, (c) =>
        c.query(
          `UPDATE background_job SET heartbeat_at = now(), lease_expires_at = now() + interval '60 seconds'
           WHERE id = $1 AND locked_by = 'zone-worker' AND status = 'PROCESSING'
           RETURNING lease_expires_at, heartbeat_at`,
          [jobId],
        ),
      );
      expect(result.rows).toHaveLength(1);
      const after = result.rows[0];
      // The extended lease must be a real instant AFTER the original
      // (never-set) one — comparing actual Date instants, not formatted
      // strings, and never off by anything resembling a timezone offset.
      expect(after.lease_expires_at.getTime()).toBeGreaterThan(Date.now());
      expect(before.leaseExpiresAt).toBeNull();

      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
    });

    it("expired-lease recovery is identical across session timezones", async () => {
      const system = createSystemClient();
      setup = await setupTestTenant();
      const jobId = await insertJob(system, setup.tenantId, {
        status: "PROCESSING",
        attempts: 1,
        maxAttempts: 5,
        leaseExpiresAt: new Date(Date.now() - 1000),
      });

      const recovered = await withZoneWorkerConnection(zone, (c) =>
        c.query(
          `UPDATE background_job
           SET status = (CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'PENDING' END)::"JobStatus",
               run_at = CASE WHEN attempts >= max_attempts THEN run_at ELSE now() END,
               locked_at = NULL, locked_by = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = now()
           WHERE status = 'PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at < now() AND id = $1
           RETURNING id, status`,
          [jobId],
        ),
      );
      expect(recovered.rows).toHaveLength(1);
      expect(recovered.rows[0].status).toBe("PENDING");

      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
    });
  });

  it("a job at the eligibility boundary behaves deterministically", async () => {
    const system = createSystemClient();
    setup = await setupTestTenant();
    const now = new Date();
    // run_at exactly equal to the comparison instant — WHERE run_at <= now()
    // must include an exact match (boundary is inclusive, not exclusive).
    const jobId = await insertJob(system, setup.tenantId, { runAt: now });

    const worker = new pg.Client({ connectionString: process.env.DATABASE_WORKER_URL });
    await worker.connect();
    try {
      const result = await worker.query(
        `SELECT id FROM background_job WHERE status = 'PENDING' AND run_at <= $1 AND id = $2`,
        [now, jobId],
      );
      expect(result.rows).toHaveLength(1);
    } finally {
      await worker.end();
    }

    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("concurrent workers cannot claim the same eligible job", async () => {
    const system = createSystemClient();
    setup = await setupTestTenant();
    await system.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.tz_matrix_concurrent",
        payload: {},
      },
    });

    const results = await Promise.all([
      claimNextJob("worker-a"),
      claimNextJob("worker-b"),
      claimNextJob("worker-c"),
    ]);
    const claimedBy = results.filter((r) => r !== null);
    expect(claimedBy.length).toBe(1);

    await system.backgroundJob.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("concurrent workers cannot claim a future-scheduled job", async () => {
    const system = createSystemClient();
    setup = await setupTestTenant();
    await insertJob(system, setup.tenantId, {
      runAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const results = await Promise.all([
      claimNextJob("worker-a2"),
      claimNextJob("worker-b2"),
    ]);
    expect(results.every((r) => r === null)).toBe(true);

    await system.backgroundJob.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("full lifecycle via the real functions: claim, heartbeat, complete", async () => {
    const system = createSystemClient();
    setup = await setupTestTenant();
    await system.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.tz_matrix_lifecycle",
        payload: {},
      },
    });

    const claimed = await claimNextJob("worker-lifecycle");
    expect(claimed).not.toBeNull();
    const heartbeatOk = await heartbeatJob(claimed!.id, "worker-lifecycle");
    expect(heartbeatOk).toBe(true);
    const completeOk = await completeJob(claimed!.id, "worker-lifecycle");
    expect(completeOk).toBe(true);

    const final = await system.backgroundJob.findUniqueOrThrow({
      where: { id: claimed!.id },
    });
    expect(final.status).toBe("SUCCEEDED");

    await system.backgroundJob.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("failJob retry sets a future run_at that reapExpiredJobLeases/claimNextJob both respect", async () => {
    const system = createSystemClient();
    setup = await setupTestTenant();
    await system.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.tz_matrix_retry",
        payload: {},
        maxAttempts: 5,
      },
    });

    const claimed = await claimNextJob("worker-retry");
    expect(claimed).not.toBeNull();
    const outcome = await failJob({
      jobId: claimed!.id,
      workerId: "worker-retry",
      attempts: claimed!.attempts,
      maxAttempts: claimed!.max_attempts,
      error: "simulated failure",
    });
    expect(outcome).toBe("RETRY");

    const afterFail = await system.backgroundJob.findUniqueOrThrow({
      where: { id: claimed!.id },
    });
    expect(afterFail.status).toBe("PENDING");
    expect(afterFail.runAt.getTime()).toBeGreaterThan(Date.now());

    // Not claimable yet — the backoff run_at is in the future.
    const tooEarly = await claimNextJob("worker-retry-2");
    expect(tooEarly).toBeNull();

    await system.backgroundJob.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("reapExpiredJobLeases recovers a job whose worker crashed mid-processing", async () => {
    const system = createSystemClient();
    setup = await setupTestTenant();
    const jobId = await insertJob(system, setup.tenantId, {
      status: "PROCESSING",
      leaseExpiresAt: new Date(Date.now() - 1000),
      lockedBy: "crashed-worker",
    });

    const recovered = await reapExpiredJobLeases(new Date());
    expect(recovered.some((r) => r.id === jobId)).toBe(true);

    const after = await system.backgroundJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(after.status).toBe("PENDING");

    await system.backgroundJob.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("terminal cleanup cannot bypass minimum retention (real function, default zone)", async () => {
    const system = createSystemClient();
    setup = await setupTestTenant();
    const jobId = await insertJob(system, setup.tenantId, { status: "SUCCEEDED" });

    await cleanupTerminalJobs(Date.now(), 0, 500);

    expect(
      await system.backgroundJob.findUnique({ where: { id: jobId } }),
    ).not.toBeNull();
    await system.backgroundJob.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("timestamps round-trip through Prisma without an eight-hour instant shift", async () => {
    const system = createSystemClient();
    setup = await setupTestTenant();
    const before = Date.now();
    const jobId = await insertJob(system, setup.tenantId, { status: "SUCCEEDED" });
    const row = await system.backgroundJob.findUniqueOrThrow({ where: { id: jobId } });
    const after = Date.now();

    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(after + 1000);

    await system.backgroundJob.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });
});

describe("outbox scheduling — timezone matrix (Phase 1H.2)", () => {
  // See the job-scheduling describe block above for the full rationale —
  // identical fail-safe pattern applied to outbox fixtures.
  let setup: Awaited<ReturnType<typeof setupTestTenant>> | undefined;
  afterEach(async () => {
    if (setup) {
      await cleanupTenant(setup.tenantId).catch(() => undefined);
      await cleanupUser(setup.adminUserId).catch(() => undefined);
      setup = undefined;
    }
  });

  describe.each(ZONES)("session timezone: %s", (zone) => {
    it("a PENDING event is claimable immediately (outbox has no run_at delay concept)", async () => {
      const system = createSystemClient();
      setup = await setupTestTenant();
      const event = await system.outboxEvent.create({
        data: {
          tenantId: setup.tenantId,
          eventType: "test.tz_matrix_outbox",
          payload: {},
        },
      });

      const claimed = await withZoneWorkerConnection(zone, (c) =>
        c.query(
          `UPDATE outbox_event
           SET status = 'PROCESSING', locked_at = now(), locked_by = 'zone-worker',
               lease_expires_at = now() + interval '60 seconds', heartbeat_at = now(), attempts = attempts + 1
           WHERE id = (SELECT id FROM outbox_event WHERE status = 'PENDING' AND id = $1 FOR UPDATE SKIP LOCKED LIMIT 1)
           RETURNING id`,
          [event.id],
        ),
      );
      expect(claimed.rows).toHaveLength(1);

      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
    });

    it("outbox lease expiry is identical across session timezones", async () => {
      const system = createSystemClient();
      setup = await setupTestTenant();
      const event = await system.outboxEvent.create({
        data: {
          tenantId: setup.tenantId,
          eventType: "test.tz_matrix_outbox_lease",
          payload: {},
        },
      });
      await system.outboxEvent.update({
        where: { id: event.id },
        data: { status: "PROCESSING", leaseExpiresAt: new Date(Date.now() - 1000) },
      });

      const expired = await withZoneWorkerConnection(zone, (c) =>
        c.query(
          `SELECT id FROM outbox_event WHERE status = 'PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at < now() AND id = $1`,
          [event.id],
        ),
      );
      expect(expired.rows).toHaveLength(1);

      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
    });

    it("outbox expired-lease recovery is identical across session timezones", async () => {
      const system = createSystemClient();
      setup = await setupTestTenant();
      const event = await system.outboxEvent.create({
        data: {
          tenantId: setup.tenantId,
          eventType: "test.tz_matrix_outbox_reap",
          payload: {},
        },
      });
      await system.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: "PROCESSING",
          attempts: 1,
          leaseExpiresAt: new Date(Date.now() - 1000),
        },
      });

      const recovered = await withZoneWorkerConnection(zone, (c) =>
        c.query(
          `UPDATE outbox_event
           SET status = (CASE WHEN attempts >= 8 THEN 'FAILED' ELSE 'PENDING' END)::"OutboxStatus",
               locked_at = NULL, locked_by = NULL, lease_expires_at = NULL, heartbeat_at = NULL
           WHERE status = 'PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at < now() AND id = $1
           RETURNING id, status`,
          [event.id],
        ),
      );
      expect(recovered.rows).toHaveLength(1);
      expect(recovered.rows[0].status).toBe("PENDING");

      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
    });
  });

  it("full outbox lifecycle via the real functions: claim, heartbeat, mark processed", async () => {
    const system = createSystemClient();
    setup = await setupTestTenant();
    await system.outboxEvent.create({
      data: {
        tenantId: setup.tenantId,
        eventType: "test.tz_matrix_outbox_lifecycle",
        payload: {},
      },
    });

    const claimed = await claimNextOutboxEvent("worker-outbox-lifecycle");
    expect(claimed).not.toBeNull();
    const heartbeatOk = await heartbeatOutboxEvent(
      claimed!.id,
      "worker-outbox-lifecycle",
    );
    expect(heartbeatOk).toBe(true);
    const processedOk = await markOutboxProcessed(claimed!.id, "worker-outbox-lifecycle");
    expect(processedOk).toBe(true);

    const final = await system.outboxEvent.findUniqueOrThrow({
      where: { id: claimed!.id },
    });
    expect(final.status).toBe("PROCESSED");

    await system.outboxEvent.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("reapExpiredOutboxLeases recovers an event whose worker crashed mid-processing", async () => {
    const system = createSystemClient();
    setup = await setupTestTenant();
    const event = await system.outboxEvent.create({
      data: {
        tenantId: setup.tenantId,
        eventType: "test.tz_matrix_outbox_crash",
        payload: {},
      },
    });
    await system.outboxEvent.update({
      where: { id: event.id },
      data: { status: "PROCESSING", leaseExpiresAt: new Date(Date.now() - 1000) },
    });

    const recovered = await reapExpiredOutboxLeases(new Date());
    expect(recovered.some((r) => r.id === event.id)).toBe(true);

    await system.outboxEvent.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("outbox terminal cleanup cannot bypass minimum retention (real function, default zone)", async () => {
    const system = createSystemClient();
    setup = await setupTestTenant();
    const event = await system.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO outbox_event (id, tenant_id, event_type, payload, status, created_at, processed_at)
       VALUES ($1, $2, 'test.tz_matrix_outbox_floor', '{}'::jsonb, 'PROCESSED', now(), now())
       RETURNING id`,
      randomUUID(),
      setup.tenantId,
    );

    await cleanupTerminalOutboxEvents(Date.now(), 0, 500);

    expect(
      await system.outboxEvent.findUnique({ where: { id: event[0]!.id } }),
    ).not.toBeNull();
    await system.outboxEvent.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });
});
