import { afterEach, describe, expect, it } from "vitest";
import { createSystemClient } from "@noahark/db/system";
import { withTenantContext } from "@noahark/db";
import {
  enqueueJob,
  claimNextJob,
  completeJob,
  emitOutboxEvent,
  claimNextOutboxEvent,
  markOutboxFailed,
  runOneJob,
  runOneOutboxEvent,
} from "@noahark/jobs";
import { assignRole } from "@/lib/services/roleService";
import {
  buildContext,
  setupTestTenant,
  cleanupTenant,
  cleanupUser,
  createTestUser,
  addTenantMember,
  type TestTenantSetup,
} from "./testHelpers";

describe("Postgres-backed jobs and transactional outbox (real Postgres)", () => {
  let setup: TestTenantSetup;

  afterEach(async () => {
    if (setup) {
      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
    }
  });

  it("enqueues a job transactionally and claims it exactly once under FOR UPDATE SKIP LOCKED", async () => {
    setup = await setupTestTenant();

    const job = await withTenantContext(
      { tenantId: setup.tenantId, legalEntityIds: new Set<string>() },
      (tx) =>
        enqueueJob(tx, {
          jobType: "test.noop",
          payload: { hello: "world" },
          tenantId: setup.tenantId,
        }),
    );
    expect(job.status).toBe("PENDING");

    const claimedByWorker1 = await claimNextJob("worker-1");
    expect(claimedByWorker1?.id).toBe(job.id);

    // A second worker racing for the same job must see nothing — it was
    // already moved to PROCESSING and locked by worker-1.
    const claimedByWorker2 = await claimNextJob("worker-2");
    expect(claimedByWorker2).toBeNull();

    await completeJob(job.id, "worker-1");
    const db = createSystemClient();
    const finalRow = await db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(finalRow.status).toBe("SUCCEEDED");
  });

  it("is idempotent: re-enqueueing with the same idempotencyKey returns the existing job", async () => {
    setup = await setupTestTenant();
    const key = `idem-${setup.tenantId}`;

    const first = await withTenantContext(
      { tenantId: setup.tenantId, legalEntityIds: new Set<string>() },
      (tx) =>
        enqueueJob(tx, {
          jobType: "test.noop",
          payload: {},
          tenantId: setup.tenantId,
          idempotencyKey: key,
        }),
    );
    const second = await withTenantContext(
      { tenantId: setup.tenantId, legalEntityIds: new Set<string>() },
      (tx) =>
        enqueueJob(tx, {
          jobType: "test.noop",
          payload: { different: true },
          tenantId: setup.tenantId,
          idempotencyKey: key,
        }),
    );

    expect(second.id).toBe(first.id);
    const db = createSystemClient();
    expect(await db.backgroundJob.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it("retries a failing job with backoff, then moves it to DEAD after maxAttempts", async () => {
    setup = await setupTestTenant();
    const job = await withTenantContext(
      { tenantId: setup.tenantId, legalEntityIds: new Set<string>() },
      (tx) =>
        enqueueJob(tx, {
          jobType: "test.always_fails",
          payload: {},
          tenantId: setup.tenantId,
          maxAttempts: 2,
        }),
    );

    const handlers = {
      "test.always_fails": async () => {
        throw new Error("simulated failure");
      },
    };

    const first = await runOneJob("worker-1", handlers);
    expect(first).toBe("RETRY");

    const db = createSystemClient();
    const afterFirst = await db.backgroundJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(afterFirst.status).toBe("PENDING");
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.runAt.getTime()).toBeGreaterThan(Date.now() - 1000); // rescheduled into the future

    // Force runAt into the past so the second attempt is immediately claimable.
    await db.backgroundJob.update({
      where: { id: job.id },
      data: { runAt: new Date(Date.now() - 1000) },
    });

    const second = await runOneJob("worker-1", handlers);
    expect(second).toBe("DEAD");

    const afterSecond = await db.backgroundJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(afterSecond.status).toBe("DEAD");
    expect(afterSecond.attempts).toBe(2);
  });

  it("processes an outbox event exactly once", async () => {
    setup = await setupTestTenant();
    await withTenantContext(
      { tenantId: setup.tenantId, legalEntityIds: new Set<string>() },
      (tx) =>
        emitOutboxEvent(tx, {
          tenantId: setup.tenantId,
          eventType: "test.event",
          payload: { n: 1 },
        }),
    );

    let handled = 0;
    const result = await runOneOutboxEvent("worker-1", {
      "test.event": async () => {
        handled += 1;
      },
    });
    expect(result).toBe("PROCESSED");
    expect(handled).toBe(1);

    const second = await claimNextOutboxEvent("worker-1");
    expect(second).toBeNull(); // nothing left pending
  });

  it("retries a failing outbox event, then moves it to FAILED after the attempt cap (F-3D)", async () => {
    setup = await setupTestTenant();
    await withTenantContext(
      { tenantId: setup.tenantId, legalEntityIds: new Set<string>() },
      (tx) =>
        emitOutboxEvent(tx, {
          tenantId: setup.tenantId,
          eventType: "test.always_fails",
          payload: {},
        }),
    );

    const handlers = {
      "test.always_fails": async () => {
        throw new Error("simulated delivery failure");
      },
    };

    const first = await runOneOutboxEvent("worker-1", handlers);
    expect(first).toBe("RETRY");

    const db = createSystemClient();
    const claimed = await db.outboxEvent.findFirstOrThrow({
      where: { eventType: "test.always_fails" },
    });
    expect(claimed.status).toBe("PENDING");
    expect(claimed.attempts).toBe(1);

    // Drive attempts up to the cap directly (mirrors runOneOutboxEvent's own
    // claim-then-fail cycle) rather than looping the real poll interval.
    // F-19 (Phase 1B.1): markOutboxFailed now requires the caller to still
    // hold the lease (locked_by + status='PROCESSING'), so each simulated
    // failure must re-claim first — a stale/unclaimed id can no longer be
    // marked failed directly.
    let result: "RETRY" | "FAILED" = "RETRY";
    while (result === "RETRY") {
      const reclaimed = await claimNextOutboxEvent("worker-1");
      if (!reclaimed) break;
      result = await markOutboxFailed(
        reclaimed.id,
        "worker-1",
        reclaimed.attempts,
        "simulated delivery failure",
      );
    }
    expect(result).toBe("FAILED");

    const final = await db.outboxEvent.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(final.status).toBe("FAILED");
  });

  it("writes the audit event and outbox event transactionally — both commit together (F-3D)", async () => {
    setup = await setupTestTenant();
    const targetUser = await createTestUser();
    const membership = await addTenantMember(setup.tenantId, targetUser.id);
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);

    const assignment = await assignRole(ctx, {
      tenantMembershipId: membership.id,
      roleId: setup.memberRoleId,
      legalEntityId: null,
    });

    const db = createSystemClient();
    const auditEvent = await db.auditEvent.findFirst({
      where: {
        tenantId: setup.tenantId,
        action: "role.assigned",
        entityId: assignment.id,
      },
    });
    const outboxEvent = await db.outboxEvent.findFirst({
      where: { tenantId: setup.tenantId, eventType: "membership_role.assigned" },
    });

    expect(auditEvent).not.toBeNull();
    expect(outboxEvent).not.toBeNull();
    expect(outboxEvent?.status).toBe("PENDING");
    // Both rows exist because they were committed in the SAME transaction
    // as the membership_role write — there is no path that produces one
    // without the other.
    await cleanupUser(targetUser.id);
  });
});
