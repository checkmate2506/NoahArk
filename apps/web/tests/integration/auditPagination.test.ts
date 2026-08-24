import { afterEach, describe, expect, it } from "vitest";
import { withTenantContext } from "@noahark/db";
import { writeAuditEvent, listAuditEvents } from "@/lib/services/auditService";
import { withGatedAuditTriggerDisabled } from "../testCleanupGate";
import {
  buildContext,
  setupTestTenant,
  cleanupTenant,
  cleanupUser,
  type TestTenantSetup,
} from "./testHelpers";

/**
 * F-32 (Phase 1B.1): stable composite-cursor audit pagination, keyed by the
 * hash chain's own monotonic `sequence` column rather than `createdAt`
 * (which ties routinely under real concurrency — see auditService.ts's
 * doc comment on listAuditEvents). The whole point of these tests is to
 * force createdAt ties deliberately and prove pagination is still exact.
 */
describe("audit event pagination (F-32, real Postgres)", () => {
  let setup: TestTenantSetup;

  afterEach(async () => {
    if (setup) {
      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
    }
  });

  async function writeNEvents(n: number, tiedCreatedAt?: Date) {
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);
    const ids: string[] = [];
    await withTenantContext(
      {
        tenantId: setup.tenantId,
        legalEntityIds: ctx.legalEntityIds,
        userId: ctx.userId,
      },
      async (tx) => {
        for (let i = 0; i < n; i++) {
          const event = await writeAuditEvent(tx, {
            tenantId: setup.tenantId,
            actorUserId: ctx.userId,
            action: "test.pagination_event",
            entityType: "test_entity",
            entityId: `entity-${i}`,
          });
          ids.push(event.id);
        }
      },
    );

    // Force every event's createdAt to the EXACT same timestamp (real
    // concurrent writers routinely tie at millisecond precision — this
    // makes the test deterministic rather than racing the clock) while
    // leaving `sequence` untouched, since that's the actual pagination key.
    // audit_event is append-only (a block trigger rejects UPDATE/DELETE
    // for every role, including superusers, with no exception — see
    // testHelpers.ts's cleanupTenant) — this is test-only manipulation to
    // force a tie deterministically, using the same gated temporary-disable
    // pattern cleanupTenant uses (P1G-1, Phase 1H: now shared via
    // testCleanupGate.ts's withGatedAuditTriggerDisabled, rather than an
    // ungated copy of the same disable/re-enable statements).
    if (tiedCreatedAt) {
      await withGatedAuditTriggerDisabled(
        "Refusing to force a tied createdAt for a test fixture",
        (db) =>
          db.auditEvent.updateMany({
            where: { id: { in: ids } },
            data: { createdAt: tiedCreatedAt },
          }),
      );
    }
    return ids;
  }

  it("paginates forward with no duplicates and no skips across many identically-timestamped events", async () => {
    setup = await setupTestTenant();
    const tiedAt = new Date("2026-01-01T00:00:00.000Z");
    const ids = await writeNEvents(37, tiedAt);

    const ctx = await buildContext(setup.adminUserId, setup.tenantId);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listAuditEvents(ctx, { cursor, limit: 5 });
      seen.push(...page.events.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThan(20); // guard against an infinite loop bug
    } while (cursor);

    const ourEvents = seen.filter((id) => ids.includes(id));
    // No duplicates.
    expect(new Set(ourEvents).size).toBe(ourEvents.length);
    // No skips — every written event was eventually seen.
    expect(new Set(ourEvents)).toEqual(new Set(ids));
  });

  it("stable traversal survives a NEW tied-timestamp event being inserted between page fetches", async () => {
    setup = await setupTestTenant();
    const tiedAt = new Date("2026-01-01T00:00:00.000Z");
    const firstBatch = await writeNEvents(5, tiedAt);

    const ctx = await buildContext(setup.adminUserId, setup.tenantId);
    const page1 = await listAuditEvents(ctx, { limit: 3 });
    expect(page1.events).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();

    // A new event lands (same tied timestamp) while the caller holds
    // page1's cursor — since the cursor bounds by `sequence < X`, this new,
    // HIGHER-sequence event must never appear on page 2 (page 2 only looks
    // BACKWARD from the cursor), and page 2 must still be exactly the
    // remaining older events with no duplication against page1.
    await writeNEvents(1, tiedAt);

    const page2 = await listAuditEvents(ctx, {
      cursor: page1.nextCursor ?? undefined,
      limit: 10,
    });
    const page2Ids = page2.events.map((e) => e.id);
    const page1Ids = page1.events.map((e) => e.id);

    expect(page2Ids.some((id) => page1Ids.includes(id))).toBe(false);
    for (const id of firstBatch) {
      expect([...page1Ids, ...page2Ids]).toContain(id);
    }
  });

  it("rejects a malformed cursor with a validation error rather than crashing", async () => {
    setup = await setupTestTenant();
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);
    await expect(
      listAuditEvents(ctx, { cursor: "not-valid-base64!!" }),
    ).rejects.toThrow();
    await expect(listAuditEvents(ctx, { cursor: "" })).resolves.toBeDefined(); // empty string is falsy -> no cursor applied
    await expect(
      listAuditEvents(ctx, { cursor: Buffer.from("not-a-number").toString("base64url") }),
    ).rejects.toThrow();
  });

  it("a cursor cannot be used to read another tenant's chain", async () => {
    setup = await setupTestTenant();
    const otherSetup = await setupTestTenant();
    try {
      await writeNEvents(3);
      const ctx = await buildContext(setup.adminUserId, setup.tenantId);
      const page = await listAuditEvents(ctx, { limit: 10 });
      expect(page.events.length).toBeGreaterThan(0);
      const cursor = page.nextCursor ?? undefined;

      // The SAME cursor value, replayed under a different tenant's own
      // context, must only ever return that OTHER tenant's own rows (or
      // none) — tenantId in the WHERE clause plus RLS both re-scope it,
      // regardless of what sequence number the cursor encodes.
      const otherCtx = await buildContext(otherSetup.adminUserId, otherSetup.tenantId);
      const crossTenantPage = await listAuditEvents(otherCtx, { cursor, limit: 10 });
      for (const event of crossTenantPage.events) {
        expect(event.tenantId).toBe(otherSetup.tenantId);
      }
    } finally {
      await cleanupTenant(otherSetup.tenantId);
      await cleanupUser(otherSetup.adminUserId);
    }
  });

  it("caps the page size at 100 even if a larger limit is requested", async () => {
    setup = await setupTestTenant();
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);
    await writeNEvents(3);
    const page = await listAuditEvents(ctx, { limit: 10_000 });
    expect(page.events.length).toBeLessThanOrEqual(100);
  });

  it("returns events in strict descending sequence order with no nextCursor once exhausted", async () => {
    setup = await setupTestTenant();
    await writeNEvents(8, new Date("2026-02-02T00:00:00.000Z"));
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);

    let cursor: string | undefined;
    let previousSequence: bigint | null = null;
    let lastPage: Awaited<ReturnType<typeof listAuditEvents>> | undefined;
    do {
      lastPage = await listAuditEvents(ctx, { cursor, limit: 3 });
      for (const event of lastPage.events) {
        if (previousSequence !== null) {
          expect(event.sequence < previousSequence).toBe(true);
        }
        previousSequence = event.sequence;
      }
      cursor = lastPage.nextCursor ?? undefined;
    } while (cursor);

    expect(lastPage?.nextCursor).toBeNull();
  });
});
