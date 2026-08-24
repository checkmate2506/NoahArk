import { afterEach, describe, expect, it } from "vitest";
import { createSystemClient } from "@noahark/db/system";
import { getWorkerClient } from "@noahark/db/worker";
import { withTenantContext } from "@noahark/db";
import {
  enqueueJob,
  runOneJob,
  type JobHandlerContext,
  type JobHandler,
} from "@noahark/jobs";
import {
  setupTestTenant,
  cleanupTenant,
  cleanupUser,
  createTestLegalEntity,
  type TestTenantSetup,
} from "./testHelpers";

/**
 * F-20 (Phase 1B.1): the worker no longer merely PROPAGATES tenant/legal-
 * entity id strings to a handler — it derives ownership from the persisted
 * job row and hands the handler a real RLS-scoped Prisma client
 * (JobHandlerContext.tx), via withJobTenantContext (packages/jobs/src/
 * context.ts). These tests exercise that against real Postgres: a handler
 * that queries `ctx.tx` must only ever see its own tenant's (and, for an
 * entity-scoped job, its own legal entity's) rows, and the underlying
 * worker queue client must remain structurally unable to read business
 * data at all.
 */
describe("worker RLS context restoration (F-20, real Postgres)", () => {
  let setups: TestTenantSetup[] = [];

  // Phase 1H.3 pre-commit cleanup (Opus finding L-4): the tenant-null
  // BackgroundJob fixture below is not tenant-scoped, so `cleanupTenant`
  // above never reaches it — a manual `deleteMany` at the end of that
  // test's own body previously owned its cleanup, which meant a mid-test
  // assertion failure left the row behind. Left uncleaned, that row is a
  // PENDING/RETRY-eligible background_job with NO tenant filter, so
  // `claimNextJob()` (by design, no tenant/type filter) could pick it up
  // in a later, unrelated test file. Tracked here instead, alongside
  // `setups`, and cleaned in the SAME fail-safe `afterEach` regardless of
  // how the test that created it ended.
  let tenantNullJobIds: string[] = [];

  async function cleanupTenantNullJobs(): Promise<void> {
    if (tenantNullJobIds.length === 0) return;
    const db = createSystemClient();
    await db.backgroundJob.deleteMany({ where: { id: { in: tenantNullJobIds } } });
    tenantNullJobIds = [];
  }

  // PostgreSQL 16 integration-stability remediation (Opus finding M-1):
  // a real throw from `cleanupTenant`/`cleanupUser` (e.g. the shared gate
  // in `testCleanupGate.ts` refusing an unsafe target) previously aborted
  // this whole `afterEach` before `cleanupTenantNullJobs()` ever ran,
  // leaving a globally-claimable tenant-null `background_job` row behind.
  // `try/finally` guarantees `cleanupTenantNullJobs()` still runs, and
  // ordinary JS try/finally semantics mean the ORIGINAL error from the
  // `try` block still propagates out of `afterEach` afterward (unless the
  // `finally` block itself throws, in which case that failure is
  // reported instead — both are genuine, informative failures; neither
  // is swallowed).
  async function runAfterEachCleanup(): Promise<void> {
    try {
      for (const setup of setups) {
        await cleanupTenant(setup.tenantId);
        await cleanupUser(setup.adminUserId);
      }
    } finally {
      setups = [];
      await cleanupTenantNullJobs();
    }
  }

  afterEach(runAfterEachCleanup);

  async function newSetup() {
    const setup = await setupTestTenant();
    setups.push(setup);
    return setup;
  }

  async function enqueueJobFor(
    setup: TestTenantSetup,
    overrides: Partial<Parameters<typeof enqueueJob>[1]> = {},
  ) {
    // WITH CHECK on background_job requires legal_entity_id (when set) to
    // be within the enqueuing transaction's own app.legal_entity_ids — so
    // the fixture must claim the entity it's about to write, exactly as a
    // real request scoped to that entity would.
    const legalEntityIds = overrides.legalEntityId
      ? new Set([overrides.legalEntityId])
      : new Set<string>();
    return withTenantContext({ tenantId: setup.tenantId, legalEntityIds }, (tx) =>
      enqueueJob(tx, {
        jobType: "test.context",
        payload: {},
        tenantId: setup.tenantId,
        ...overrides,
      }),
    );
  }

  it.each(["SG", "MY", "ID"] as const)(
    "runs a %s legal-entity-scoped job with a client that sees only that entity",
    async (jurisdiction) => {
      const setup = await newSetup();
      const legalEntity = await createTestLegalEntity(setup.tenantId, jurisdiction);
      const otherEntity = await createTestLegalEntity(setup.tenantId, jurisdiction);
      const job = await enqueueJobFor(setup, { legalEntityId: legalEntity.id });

      let seenIds: string[] = [];
      const handlers: Record<string, JobHandler> = {
        "test.context": async (_payload, ctx: JobHandlerContext) => {
          expect(ctx.tenantId).toBe(setup.tenantId);
          expect(ctx.legalEntityId).toBe(legalEntity.id);
          const rows = await ctx.tx.legalEntity.findMany({
            where: { tenantId: setup.tenantId },
          });
          seenIds = rows.map((r) => r.id);
        },
      };

      const result = await runOneJob(`worker-${job.id}`, handlers);
      expect(result).toBe("SUCCEEDED");
      // legal_entity's own RLS policy is tenant-scoped only (not further
      // filtered by legal_entity_ids — see the RLS migration comment), so
      // both entities in the tenant are visible; the entity-scoping is
      // what governs entity-scoped SUB-resources, exercised below.
      expect(seenIds).toEqual(expect.arrayContaining([legalEntity.id, otherEntity.id]));
    },
  );

  it("a tenant-wide job (no legal_entity_id) resolves the full set of the tenant's legal entities", async () => {
    const setup = await newSetup();
    const entityA = await createTestLegalEntity(setup.tenantId, "SG");
    const entityB = await createTestLegalEntity(setup.tenantId, "MY");
    const job = await enqueueJobFor(setup); // no legalEntityId

    let sawDeptA = false;
    let sawDeptB = false;
    const db = createSystemClient();
    const deptA = await db.businessUnit.create({
      data: { tenantId: setup.tenantId, legalEntityId: entityA.id, name: "Dept A" },
    });
    const deptB = await db.businessUnit.create({
      data: { tenantId: setup.tenantId, legalEntityId: entityB.id, name: "Dept B" },
    });

    const handlers: Record<string, JobHandler> = {
      "test.context": async (_payload, ctx: JobHandlerContext) => {
        expect(ctx.legalEntityId).toBeNull();
        const depts = await ctx.tx.businessUnit.findMany({
          where: { tenantId: setup.tenantId },
        });
        const ids = depts.map((d) => d.id);
        sawDeptA = ids.includes(deptA.id);
        sawDeptB = ids.includes(deptB.id);
      },
    };

    const result = await runOneJob(`worker-${job.id}`, handlers);
    expect(result).toBe("SUCCEEDED");
    expect(sawDeptA).toBe(true);
    expect(sawDeptB).toBe(true);
  });

  it("an entity-scoped job's handler CANNOT see another legal entity's entity-scoped rows", async () => {
    const setup = await newSetup();
    const grantedEntity = await createTestLegalEntity(setup.tenantId, "SG");
    const otherEntity = await createTestLegalEntity(setup.tenantId, "MY");
    const job = await enqueueJobFor(setup, { legalEntityId: grantedEntity.id });

    const db = createSystemClient();
    const grantedDept = await db.businessUnit.create({
      data: {
        tenantId: setup.tenantId,
        legalEntityId: grantedEntity.id,
        name: "Granted Dept",
      },
    });
    const otherDept = await db.businessUnit.create({
      data: {
        tenantId: setup.tenantId,
        legalEntityId: otherEntity.id,
        name: "Other Dept",
      },
    });

    let visibleIds: string[] = [];
    const handlers: Record<string, JobHandler> = {
      "test.context": async (_payload, ctx: JobHandlerContext) => {
        const depts = await ctx.tx.businessUnit.findMany({
          where: { tenantId: setup.tenantId },
        });
        visibleIds = depts.map((d) => d.id);
      },
    };

    const result = await runOneJob(`worker-${job.id}`, handlers);
    expect(result).toBe("SUCCEEDED");
    expect(visibleIds).toContain(grantedDept.id);
    expect(visibleIds).not.toContain(otherDept.id);
  });

  it("fails closed on missing tenant ownership (tenant_id is null) rather than running the handler unscoped", async () => {
    // BackgroundJob.tenantId is nullable at the schema level (reserved for
    // a future platform-wide job concept), but Phase 1 has no such handler
    // — a claimed job with no tenant must never reach a handler at all.
    const db = createSystemClient();
    const job = await db.backgroundJob.create({
      data: { jobType: "test.context", payload: {}, tenantId: null, maxAttempts: 3 },
    });
    // Tracked immediately after creation — before any assertion below has
    // a chance to throw — so the fail-safe `afterEach` above removes this
    // row regardless of where (or whether) this test fails.
    tenantNullJobIds.push(job.id);

    let handlerRan = false;
    const handlers: Record<string, JobHandler> = {
      "test.context": async () => {
        handlerRan = true;
      },
    };

    const result = await runOneJob("worker-no-tenant", handlers);
    expect(result).toBe("RETRY"); // attempts (1) < maxAttempts (3)
    expect(handlerRan).toBe(false);

    const row = await db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.lastError).toMatch(/no tenant ownership/i);

    // Recorded on the PLATFORM audit chain (tenant_id null) — there is no
    // tenant to attribute a missing-tenant failure to.
    const auditRow = await db.auditEvent.findFirst({
      where: { tenantId: null, entityId: job.id, action: "job.context_rejected" },
    });
    expect(auditRow).not.toBeNull();
    // No manual cleanup here — the fail-safe `afterEach` above owns it,
    // proven below on both the success and the deliberate-failure path.
  });

  it("the tenant-null job fixture is removed by the shared cleanup even after a simulated mid-test failure", async () => {
    // Proves the fix for L-4 without leaving an actually-failing test in
    // the permanent suite: the id is tracked the moment the row is
    // created (matching the real test above), a failure is triggered and
    // caught HERE (standing in for an assertion throwing mid-test), and
    // then the exact same cleanup function `afterEach` calls is invoked
    // manually to prove it removes the row — before also letting the
    // real `afterEach` run at the end of this test as an additional,
    // genuine check (asserting again would be redundant; not deleting the
    // row a second time is fine, `cleanupTenantNullJobs` is idempotent
    // once the array is empty).
    const db = createSystemClient();
    const job = await db.backgroundJob.create({
      data: { jobType: "test.context", payload: {}, tenantId: null, maxAttempts: 3 },
    });
    tenantNullJobIds.push(job.id);

    expect(() => {
      throw new Error("simulated mid-test assertion failure");
    }).toThrow();

    // The row must still exist right now — cleanup is afterEach-scoped,
    // not automatic on throw.
    const stillThere = await db.backgroundJob.findUnique({ where: { id: job.id } });
    expect(stillThere).not.toBeNull();

    // Invoke the SAME cleanup function the real afterEach calls.
    await cleanupTenantNullJobs();

    const goneAfterCleanup = await db.backgroundJob.findUnique({ where: { id: job.id } });
    expect(goneAfterCleanup).toBeNull();

    // No globally claimable row survives: confirm nothing eligible for
    // claimNextJob() remains for this job type at all.
    const anyRemaining = await db.backgroundJob.findMany({
      where: { jobType: "test.context", tenantId: null },
    });
    expect(anyRemaining).toEqual([]);
  });

  it("cleanupTenantNullJobs still runs, and the original error still propagates, when cleanupTenant throws (M-1)", async () => {
    // Proves the M-1 fix with a GENUINE throw from cleanupTenant — not a
    // mock or a fabricated error — by temporarily clearing the shared
    // gate's required ALLOW_TEST_DB_PURGE=1 confirmation
    // (testCleanupGate.ts's assertTestCleanupAllowedForCurrentEnv, the
    // very first thing withGatedAuditTriggerDisabled calls, before it
    // ever touches a trigger or a row) so cleanupTenant refuses exactly
    // as it would for a real misconfiguration, then calling the actual
    // afterEach body (runAfterEachCleanup) directly to observe both its
    // guaranteed side effect (tenant-null job removed) and its guaranteed
    // propagated failure (the original error is not swallowed).
    const db = createSystemClient();
    const job = await db.backgroundJob.create({
      data: { jobType: "test.context", payload: {}, tenantId: null, maxAttempts: 3 },
    });
    tenantNullJobIds.push(job.id);

    // A placeholder setup — cleanupTenant throws on the gate check before
    // this tenantId is ever read, so its value is irrelevant.
    setups.push({
      tenantId: "00000000-0000-0000-0000-000000000000",
      adminUserId: "00000000-0000-0000-0000-000000000000",
      adminMembershipId: "00000000-0000-0000-0000-000000000000",
      adminRoleId: "00000000-0000-0000-0000-000000000000",
      memberRoleId: "00000000-0000-0000-0000-000000000000",
    });

    const originalFlag = process.env.ALLOW_TEST_DB_PURGE;
    delete process.env.ALLOW_TEST_DB_PURGE;
    try {
      await expect(runAfterEachCleanup()).rejects.toThrow(/ALLOW_TEST_DB_PURGE/);
    } finally {
      process.env.ALLOW_TEST_DB_PURGE = originalFlag;
    }

    // The finally block inside runAfterEachCleanup must still have run
    // cleanupTenantNullJobs() despite cleanupTenant's throw.
    const goneAfterCleanup = await db.backgroundJob.findUnique({ where: { id: job.id } });
    expect(goneAfterCleanup).toBeNull();

    // The same finally block also reset `setups` — the real afterEach
    // that runs automatically after this test has nothing left to do.
    expect(setups).toEqual([]);
    expect(tenantNullJobIds).toEqual([]);
  });

  it("fails closed when the job's legal_entity_id does not belong to its own tenant_id", async () => {
    const setupA = await newSetup();
    const setupB = await newSetup();
    const entityInTenantB = await createTestLegalEntity(setupB.tenantId, "ID");

    // Directly construct an inconsistent row (tenant A, but an entity that
    // belongs to tenant B) — this can only happen via a bug or tampering,
    // exactly the case withJobTenantContext must fail closed on.
    const db = createSystemClient();
    const job = await db.backgroundJob.create({
      data: {
        jobType: "test.context",
        payload: {},
        tenantId: setupA.tenantId,
        legalEntityId: entityInTenantB.id,
        maxAttempts: 3,
      },
    });

    let handlerRan = false;
    const handlers: Record<string, JobHandler> = {
      "test.context": async () => {
        handlerRan = true;
      },
    };

    const result = await runOneJob("worker-cross-tenant-entity", handlers);
    expect(result).toBe("RETRY");
    expect(handlerRan).toBe(false);

    const row = await db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.lastError).toMatch(/does not belong to its own tenant/i);

    // This one DOES have a known tenant, so it's recorded on THAT tenant's
    // own chain, not the platform chain.
    const auditRow = await db.auditEvent.findFirst({
      where: {
        tenantId: setupA.tenantId,
        entityId: job.id,
        action: "job.context_rejected",
      },
    });
    expect(auditRow).not.toBeNull();

    await db.backgroundJob.deleteMany({ where: { id: job.id } });
  });

  it("legal entity from another tenant, even when tenant_id itself is correct, is rejected the same way", async () => {
    const setup = await newSetup();
    const otherSetup = await newSetup();
    const foreignEntity = await createTestLegalEntity(otherSetup.tenantId, "SG");

    await enqueueJobFor(setup, { legalEntityId: foreignEntity.id });

    const handlers: Record<string, JobHandler> = {
      "test.context": async () => {
        throw new Error("handler must never run");
      },
    };

    const result = await runOneJob("worker-foreign-entity", handlers);
    expect(result).toBe("RETRY");
  });

  it("a crafted payload tenantId/legalEntityId is never consulted — the persisted row always wins", async () => {
    const setup = await newSetup();
    const otherSetup = await newSetup();
    await enqueueJobFor(setup, {
      payload: { tenantId: otherSetup.tenantId, legalEntityId: "not-a-real-id" },
    });

    let observedTenantId: string | null = null;
    const handlers: Record<string, JobHandler> = {
      "test.context": async (payload, ctx: JobHandlerContext) => {
        // The payload DOES contain a different tenantId (an attacker-style
        // substitution attempt) — the scoped context must still reflect the
        // job row's real tenant, never the payload's claim.
        expect((payload as { tenantId: string }).tenantId).toBe(otherSetup.tenantId);
        observedTenantId = ctx.tenantId;
        const rows = await ctx.tx.tenant.findMany({ where: { id: ctx.tenantId } });
        expect(rows).toHaveLength(1);
        expect(rows[0]!.id).toBe(setup.tenantId);
      },
    };

    const result = await runOneJob("worker-payload-substitution", handlers);
    expect(result).toBe("SUCCEEDED");
    expect(observedTenantId).toBe(setup.tenantId);
  });

  it("context is cleared after a successful run — a later unscoped read sees nothing left over", async () => {
    const setup = await newSetup();
    await enqueueJobFor(setup);

    const handlers: Record<string, JobHandler> = {
      "test.context": async () => {},
    };
    await runOneJob("worker-cleanup-success", handlers);

    // A fresh, ordinary tenant context for a DIFFERENT tenant must not
    // observe the previous job's tenant — proves withTenantContext's
    // transaction-scoped `SET LOCAL`-style config never leaks across
    // pooled-connection reuse (see client.ts's own doc comment on this).
    const otherSetup = await newSetup();
    await withTenantContext(
      { tenantId: otherSetup.tenantId, legalEntityIds: new Set() },
      async (tx) => {
        const rows = await tx.tenant.findMany({ where: { id: setup.tenantId } });
        expect(rows).toHaveLength(0);
      },
    );
  });

  it("context is cleared after a failed handler run too", async () => {
    const setup = await newSetup();
    await enqueueJobFor(setup);

    const handlers: Record<string, JobHandler> = {
      "test.context": async () => {
        throw new Error("simulated handler failure");
      },
    };
    await runOneJob("worker-cleanup-failure", handlers);

    const otherSetup = await newSetup();
    await withTenantContext(
      { tenantId: otherSetup.tenantId, legalEntityIds: new Set() },
      async (tx) => {
        const rows = await tx.tenant.findMany({ where: { id: setup.tenantId } });
        expect(rows).toHaveLength(0);
      },
    );
  });

  it("the worker queue client (noahark_worker) cannot read an ordinary tenant table at all", async () => {
    const setup = await newSetup();
    const workerDb = getWorkerClient();
    await expect(
      workerDb.tenant.findMany({ where: { id: setup.tenantId } }),
    ).rejects.toThrow();
  });

  it("a handler cannot escape ctx.tx to reach an unscoped or cross-tenant view", async () => {
    const setup = await newSetup();
    const otherSetup = await newSetup();
    await enqueueJobFor(setup);

    let crossTenantRows: unknown[] = [];
    const handlers: Record<string, JobHandler> = {
      "test.context": async (_payload, ctx: JobHandlerContext) => {
        // The ONLY client available to the handler is ctx.tx — attempting
        // to read another tenant's row through it must see nothing, RLS
        // enforced at the database, not merely an application-level check
        // the handler could have skipped.
        crossTenantRows = await ctx.tx.tenant.findMany({
          where: { id: otherSetup.tenantId },
        });
      },
    };

    const result = await runOneJob("worker-no-escape", handlers);
    expect(result).toBe("SUCCEEDED");
    expect(crossTenantRows).toHaveLength(0);
  });
});
