import { afterEach, describe, expect, it } from "vitest";
import { createSystemClient } from "@noahark/db/system";
import { withTenantContext } from "@noahark/db";
import {
  enqueueJob,
  claimNextJob,
  completeJob,
  failJob,
  heartbeatJob,
  reapExpiredJobLeases,
  JOB_LEASE_DURATION_MS,
} from "@noahark/jobs";
import {
  setupTestTenant,
  cleanupTenant,
  cleanupUser,
  type TestTenantSetup,
} from "./testHelpers";

/**
 * F-19 (Phase 1B.1): durable job leases and crash recovery. All against
 * real Postgres — the atomicity/ownership guarantees under test (FOR
 * UPDATE SKIP LOCKED, the locked_by-gated completion, the single-UPDATE
 * reaper) are exactly the properties that don't show up correctly against
 * a mock.
 */
describe("job leases and crash recovery (F-19, real Postgres)", () => {
  let setup: TestTenantSetup;

  afterEach(async () => {
    if (setup) {
      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
    }
  });

  async function enqueue(overrides: Partial<Parameters<typeof enqueueJob>[1]> = {}) {
    return withTenantContext(
      { tenantId: setup.tenantId, legalEntityIds: new Set<string>() },
      (tx) =>
        enqueueJob(tx, {
          jobType: "test.noop",
          payload: {},
          tenantId: setup.tenantId,
          ...overrides,
        }),
    );
  }

  it("normal claim sets a lease and completion clears it", async () => {
    setup = await setupTestTenant();
    const job = await enqueue();

    const claimed = await claimNextJob("worker-1");
    expect(claimed?.id).toBe(job.id);

    const db = createSystemClient();
    const afterClaim = await db.backgroundJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(afterClaim.status).toBe("PROCESSING");
    expect(afterClaim.lockedBy).toBe("worker-1");
    expect(afterClaim.leaseExpiresAt).not.toBeNull();
    expect(afterClaim.heartbeatAt).not.toBeNull();
    expect(afterClaim.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    const completed = await completeJob(job.id, "worker-1");
    expect(completed).toBe(true);

    const final = await db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(final.status).toBe("SUCCEEDED");
    expect(final.lockedBy).toBeNull();
    expect(final.leaseExpiresAt).toBeNull();
    expect(final.heartbeatAt).toBeNull();
  });

  it("two workers racing for the same job: exactly one claims it", async () => {
    setup = await setupTestTenant();
    const job = await enqueue();

    const [a, b] = await Promise.all([
      claimNextJob("worker-a"),
      claimNextJob("worker-b"),
    ]);
    const claimedIds = [a, b].filter((c) => c?.id === job.id);
    expect(claimedIds).toHaveLength(1);
  });

  it("worker crash: a job with no heartbeat past its lease is recovered by the reaper", async () => {
    setup = await setupTestTenant();
    const job = await enqueue();

    await claimNextJob("worker-crashed");
    // Simulate the crash: back-date the lease as if JOB_LEASE_DURATION_MS
    // had already elapsed with no heartbeat reaching the database.
    const db = createSystemClient();
    await db.backgroundJob.update({
      where: { id: job.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });

    const reaped = await reapExpiredJobLeases();
    expect(reaped.map((r) => r.id)).toContain(job.id);
    expect(reaped.find((r) => r.id === job.id)?.recoveredTo).toBe("PENDING");

    const recovered = await db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(recovered.status).toBe("PENDING");
    expect(recovered.lockedBy).toBeNull();
    expect(recovered.leaseExpiresAt).toBeNull();

    // A different worker can now claim it.
    const reclaimed = await claimNextJob("worker-2");
    expect(reclaimed?.id).toBe(job.id);
    // attempts was incremented once at the original claim and once at
    // reclaim — never double-counted by the reap itself.
    expect(reclaimed?.attempts).toBe(2);
  });

  it("a job whose lease is still valid is NOT touched by the reaper", async () => {
    setup = await setupTestTenant();
    const job = await enqueue();
    await claimNextJob("worker-1");

    const reaped = await reapExpiredJobLeases();
    expect(reaped.map((r) => r.id)).not.toContain(job.id);

    const db = createSystemClient();
    const row = await db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("PROCESSING");
    expect(row.lockedBy).toBe("worker-1");
  });

  it("concurrent reapers never double-recover the same job", async () => {
    setup = await setupTestTenant();
    const job = await enqueue();
    await claimNextJob("worker-crashed");
    const db = createSystemClient();
    await db.backgroundJob.update({
      where: { id: job.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });

    const [reapA, reapB, reapC] = await Promise.all([
      reapExpiredJobLeases(),
      reapExpiredJobLeases(),
      reapExpiredJobLeases(),
    ]);
    const totalRecoveries = [reapA, reapB, reapC].filter((r) =>
      r.some((x) => x.id === job.id),
    ).length;
    expect(totalRecoveries).toBe(1);
  });

  it("a stale worker (already reaped) cannot complete the job out from under the new owner", async () => {
    setup = await setupTestTenant();
    const job = await enqueue();
    await claimNextJob("worker-stale");

    const db = createSystemClient();
    await db.backgroundJob.update({
      where: { id: job.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    await reapExpiredJobLeases();
    await claimNextJob("worker-new"); // reclaims it

    // The original (stale) worker, unaware it was reaped, tries to complete.
    const staleCompleted = await completeJob(job.id, "worker-stale");
    expect(staleCompleted).toBe(false);

    const row = await db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("PROCESSING");
    expect(row.lockedBy).toBe("worker-new");

    // The new owner can still legitimately complete it.
    const newCompleted = await completeJob(job.id, "worker-new");
    expect(newCompleted).toBe(true);
  });

  it("a stale worker cannot fail the job out from under the new owner either", async () => {
    setup = await setupTestTenant();
    const job = await enqueue();
    await claimNextJob("worker-stale");
    const db = createSystemClient();
    await db.backgroundJob.update({
      where: { id: job.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    await reapExpiredJobLeases();
    await claimNextJob("worker-new");

    const staleResult = await failJob({
      jobId: job.id,
      workerId: "worker-stale",
      attempts: 1,
      maxAttempts: 5,
      error: "stale failure report",
    }).catch((e) => e);
    // failJob always resolves (it doesn't throw on a no-op) — assert the
    // row was left untouched by the stale caller regardless of the
    // resolved label.
    expect(["RETRY", "DEAD"]).toContain(staleResult);

    const row = await db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("PROCESSING");
    expect(row.lockedBy).toBe("worker-new");
  });

  it("heartbeat extends the lease and is rejected once the caller is no longer the owner", async () => {
    setup = await setupTestTenant();
    const job = await enqueue();
    await claimNextJob("worker-1");
    const db = createSystemClient();
    const afterClaim = await db.backgroundJob.findUniqueOrThrow({
      where: { id: job.id },
    });

    await new Promise((r) => setTimeout(r, 20));
    const beat = await heartbeatJob(job.id, "worker-1");
    expect(beat).toBe(true);

    const afterHeartbeat = await db.backgroundJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(afterHeartbeat.leaseExpiresAt!.getTime()).toBeGreaterThanOrEqual(
      afterClaim.leaseExpiresAt!.getTime(),
    );
    expect(afterHeartbeat.heartbeatAt!.getTime()).toBeGreaterThan(
      afterClaim.heartbeatAt!.getTime(),
    );

    // An unrelated worker id can never heartbeat someone else's claim.
    const wrongWorkerBeat = await heartbeatJob(job.id, "worker-imposter");
    expect(wrongWorkerBeat).toBe(false);

    await completeJob(job.id, "worker-1");
    // Heartbeating a completed job also fails — status is no longer PROCESSING.
    const afterCompleteBeat = await heartbeatJob(job.id, "worker-1");
    expect(afterCompleteBeat).toBe(false);
  });

  it("moves to DEAD once max attempts is reached, staying retryable below it", async () => {
    setup = await setupTestTenant();
    const job = await enqueue({ maxAttempts: 2 });

    const claim1 = await claimNextJob("worker-1");
    const outcome1 = await failJob({
      jobId: job.id,
      workerId: "worker-1",
      attempts: claim1!.attempts,
      maxAttempts: 2,
      error: "boom",
    });
    expect(outcome1).toBe("RETRY");

    const db = createSystemClient();
    await db.backgroundJob.update({
      where: { id: job.id },
      data: { runAt: new Date(Date.now() - 1000) },
    });

    const claim2 = await claimNextJob("worker-1");
    expect(claim2?.attempts).toBe(2);
    const outcome2 = await failJob({
      jobId: job.id,
      workerId: "worker-1",
      attempts: claim2!.attempts,
      maxAttempts: 2,
      error: "boom again",
    });
    expect(outcome2).toBe("DEAD");

    const final = await db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(final.status).toBe("DEAD");
  });

  it("a reaped job that has exhausted max attempts recovers to DEAD, not PENDING", async () => {
    setup = await setupTestTenant();
    const job = await enqueue({ maxAttempts: 1 });
    await claimNextJob("worker-crashed"); // attempts now 1, equals maxAttempts

    const db = createSystemClient();
    await db.backgroundJob.update({
      where: { id: job.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });

    const reaped = await reapExpiredJobLeases();
    expect(reaped.find((r) => r.id === job.id)?.recoveredTo).toBe("DEAD");

    const row = await db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("DEAD");
  });

  it("idempotent reclaim: reaping the same already-recovered job twice is a no-op the second time", async () => {
    setup = await setupTestTenant();
    const job = await enqueue();
    await claimNextJob("worker-crashed");
    const db = createSystemClient();
    await db.backgroundJob.update({
      where: { id: job.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });

    const firstReap = await reapExpiredJobLeases();
    expect(firstReap.map((r) => r.id)).toContain(job.id);

    const secondReap = await reapExpiredJobLeases();
    expect(secondReap.map((r) => r.id)).not.toContain(job.id);
  });

  it("retry scheduling: a normal (non-reaped) failure schedules the retry into the future with backoff", async () => {
    setup = await setupTestTenant();
    const job = await enqueue({ maxAttempts: 5 });
    const claimed = await claimNextJob("worker-1");

    const before = Date.now();
    const outcome = await failJob({
      jobId: job.id,
      workerId: "worker-1",
      attempts: claimed!.attempts,
      maxAttempts: 5,
      error: "transient",
    });
    expect(outcome).toBe("RETRY");

    const db = createSystemClient();
    const row = await db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("PENDING");
    expect(row.runAt.getTime()).toBeGreaterThan(before);
  });

  it("JOB_LEASE_DURATION_MS is a sane bounded positive duration", () => {
    expect(JOB_LEASE_DURATION_MS).toBeGreaterThan(0);
    expect(JOB_LEASE_DURATION_MS).toBeLessThan(60 * 60_000); // under an hour — bounded, not unbounded
  });
});
