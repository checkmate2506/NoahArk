import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { verifyAuditChain, type AuditChainLink } from "@noahark/audit";
import type { AccessContext } from "@noahark/core";
import { ConflictError, NotFoundError, StaleVersionError } from "@noahark/core";
import { createSystemClient } from "@noahark/db/system";
import { withTenantContext } from "@noahark/db";
import {
  archivePriceListAssignment,
  closePriceListEntry,
  createCatalogItemAssignment,
  createPriceListAssignment,
  createPriceListEntry,
  resolveEffectivePrice,
  setDefaultPriceList,
  transferPriceListOwnership,
  updateCatalogItemAssignment,
  updatePriceListAssignment,
  updatePriceListEntry,
} from "@noahark/catalog";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  contextWithEntities,
  createTestItem,
  createTestPriceList,
  createTestUom,
  setupPricingDomainFixture,
  type PricingDomainFixture,
} from "./pricingDomainFixture";

function assignmentKey(tenantId: string, priceListId: string): string {
  return `price-list-assignments:${tenantId}:${priceListId}`;
}

function leak(text: string) {
  expect(text).not.toMatch(/SQLSTATE/i);
  expect(text).not.toMatch(/23P01/);
  expect(text).not.toMatch(/prisma/i);
  expect(text).not.toMatch(/pg_/);
  expect(text).not.toMatch(/_key/);
  expect(text).not.toMatch(/_check/);
  expect(text).not.toMatch(/_fkey/);
  expect(text).not.toMatch(/price_list_entry/);
  expect(text).not.toMatch(/price_list_legal_entity_assignment/);
}

async function holdTx(
  ctx: AccessContext,
  acquire: (client: pg.Client) => Promise<void>,
  whileHeld: () => Promise<void>,
  then: (client: pg.Client) => Promise<void> = async () => undefined,
): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
    await client.query("SELECT set_config('app.legal_entity_ids', $1, true)", [
      Array.from(ctx.legalEntityIds).join(","),
    ]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [ctx.userId]);
    await acquire(client);
    await whileHeld();
    await then(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function waitUntil(sql: string, label: string): Promise<void> {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error("DATABASE_MIGRATION_URL is not set");
  const observer = new pg.Client({ connectionString: url });
  await observer.connect();
  try {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const result = await observer.query<{ n: string }>(sql);
      if (Number(result.rows[0]?.n ?? 0) > 0) return;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`timed out waiting for ${label}`);
  } finally {
    await observer.end();
  }
}

function waitUntilAdvisoryWaiter(): Promise<void> {
  return waitUntil(
    `SELECT count(*)::text AS n
     FROM pg_locks
     WHERE locktype = 'advisory' AND NOT granted`,
    "a blocked advisory lock",
  );
}

function waitUntilRowLockWaiter(): Promise<void> {
  return waitUntil(
    `SELECT count(*)::text AS n
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND pid <> pg_backend_pid()
       AND wait_event_type = 'Lock'`,
    "a blocked row lock",
  );
}

function toAuditLinks(
  rows: Array<{
    prevHash: string | null;
    hash: string;
    sequence: bigint;
    tenantId: string | null;
    legalEntityId: string | null;
    actorUserId: string | null;
    actorType: string;
    action: string;
    entityType: string;
    entityId: string | null;
    beforeData: unknown;
    afterData: unknown;
    outcome: string;
    createdAt: Date;
    chainKey: string;
  }>,
): AuditChainLink[] {
  return rows.map((row) => ({
    prevHash: row.prevHash,
    hash: row.hash,
    sequence: row.sequence,
    payload: {
      tenantId: row.tenantId,
      legalEntityId: row.legalEntityId,
      actorUserId: row.actorUserId,
      actorType: row.actorType,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      beforeData: row.beforeData,
      afterData: row.afterData,
      outcome: row.outcome,
      createdAt: row.createdAt.toISOString(),
      chainKey: row.chainKey,
      sequence: row.sequence.toString(),
    },
  }));
}

describe("P2C.2 — pricing concurrency races", () => {
  let fixture: PricingDomainFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("overlapping entry creates: one winner, leak-free ConflictError", async () => {
    fixture = await setupPricingDomainFixture();
    const { ctxA, leA } = fixture;
    const uom = await createTestUom(ctxA);
    const item = await createTestItem(ctxA, leA.id, uom.id);
    const list = await createTestPriceList(ctxA, leA.id);
    const payload = {
      priceListAssignmentId: list.assignment.id,
      catalogItemAssignmentId: item.assignment.id,
      unitPrice: "1",
      effectiveFrom: "2026-07-01",
      effectiveTo: "2026-07-31" as string | null,
    };
    const settled = await Promise.allSettled([
      createPriceListEntry(ctxA, payload),
      createPriceListEntry(ctxA, payload),
    ]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      ConflictError,
    );
    if (rejected?.status === "rejected") leak(String(rejected.reason.message));
    const db = createSystemClient();
    expect(
      await db.priceListEntry.count({
        where: { priceListAssignmentId: list.assignment.id },
      }),
    ).toBe(1);
  });

  it("two concurrent default swaps leave exactly one ACTIVE default", async () => {
    fixture = await setupPricingDomainFixture();
    const { ctxA, leA } = fixture;
    const first = await createTestPriceList(ctxA, leA.id, "SGD", "D1");
    const second = await createTestPriceList(ctxA, leA.id, "SGD", "D2");
    await setDefaultPriceList(ctxA, {
      legalEntityId: leA.id,
      priceListId: first.priceList.id,
    });
    const settled = await Promise.allSettled([
      setDefaultPriceList(ctxA, {
        legalEntityId: leA.id,
        priceListId: second.priceList.id,
      }),
      setDefaultPriceList(ctxA, {
        legalEntityId: leA.id,
        priceListId: first.priceList.id,
      }),
    ]);
    expect(settled.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(
      1,
    );
    const db = createSystemClient();
    expect(
      await db.priceListLegalEntityAssignment.count({
        where: { legalEntityId: leA.id, isDefault: true, status: "ACTIVE" },
      }),
    ).toBe(1);
  });

  it("default swap vs suspend and archive, both orderings", async () => {
    fixture = await setupPricingDomainFixture();
    const { ctxA, ctxAB, leA, leB } = fixture;
    const list = await createTestPriceList(ctxA, leA.id);
    await createPriceListAssignment(ctxAB, {
      priceListId: list.priceList.id,
      legalEntityId: leB.id,
    });
    await setDefaultPriceList(ctxA, {
      legalEntityId: leA.id,
      priceListId: list.priceList.id,
    });
    const assignA = list.assignment;
    const settled = await Promise.allSettled([
      setDefaultPriceList(ctxA, { legalEntityId: leA.id, priceListId: null }),
      updatePriceListAssignment(ctxAB, assignA.id, {
        expectedVersion: assignA.version + 1,
        status: "SUSPENDED",
      }),
    ]);
    expect(settled.some((r) => r.status === "fulfilled")).toBe(true);
    const db = createSystemClient();
    expect(
      await db.priceListLegalEntityAssignment.count({
        where: { legalEntityId: leA.id, isDefault: true, status: "ACTIVE" },
      }),
    ).toBeLessThanOrEqual(1);

    const list2 = await createTestPriceList(ctxA, leA.id, "SGD", "Arch");
    await createPriceListAssignment(ctxAB, {
      priceListId: list2.priceList.id,
      legalEntityId: leB.id,
    });
    await setDefaultPriceList(ctxA, {
      legalEntityId: leA.id,
      priceListId: list2.priceList.id,
    });
    const a2 = await db.priceListLegalEntityAssignment.findFirstOrThrow({
      where: { priceListId: list2.priceList.id, legalEntityId: leA.id },
    });
    const settled2 = await Promise.allSettled([
      setDefaultPriceList(ctxA, { legalEntityId: leA.id, priceListId: null }),
      archivePriceListAssignment(ctxAB, a2.id, a2.version),
    ]);
    expect(settled2.some((r) => r.status === "fulfilled")).toBe(true);
  });

  it("transfer vs assignment-create, both orderings, plus production transfer probe", async () => {
    fixture = await setupPricingDomainFixture();
    const { ctxA, ctxAB, leA, leB, leC, leD } = fixture;
    const created = await createTestPriceList(ctxA, leA.id);
    const transferred = await transferPriceListOwnership(ctxAB, created.priceList.id, {
      newOwnerLegalEntityId: leB.id,
      expectedVersion: created.priceList.version,
    });
    const ctxBC = contextWithEntities(ctxAB, [leB.id, leC.id]);
    const ctxBD = contextWithEntities(ctxAB, [leB.id, leD.id]);
    const db = createSystemClient();

    let createDone: Promise<void> | undefined;
    await holdTx(
      ctxBC,
      async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          assignmentKey(ctxA.tenantId, created.priceList.id),
        ]);
      },
      async () => {
        const pending = createPriceListAssignment(ctxBC, {
          priceListId: created.priceList.id,
          legalEntityId: leC.id,
        });
        createDone = expect(pending).resolves.toMatchObject({
          legalEntityId: leC.id,
          status: "ACTIVE",
        });
        await waitUntilAdvisoryWaiter();
      },
    );
    await createDone;
    await transferPriceListOwnership(ctxBD, created.priceList.id, {
      newOwnerLegalEntityId: leD.id,
      expectedVersion: transferred.version,
    });

    const created2 = await createTestPriceList(ctxA, leA.id, "SGD", "TOCTOU B");
    const transferred2 = await transferPriceListOwnership(ctxAB, created2.priceList.id, {
      newOwnerLegalEntityId: leB.id,
      expectedVersion: created2.priceList.version,
    });
    const auditsBefore = await db.auditEvent.count({
      where: { tenantId: ctxA.tenantId, action: "price_list_assignment.created" },
    });
    let createRejected: Promise<void> | undefined;
    await holdTx(
      ctxBD,
      async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          assignmentKey(ctxA.tenantId, created2.priceList.id),
        ]);
      },
      async () => {
        const pending = createPriceListAssignment(ctxBC, {
          priceListId: created2.priceList.id,
          legalEntityId: leC.id,
        });
        createRejected = expect(pending).rejects.toBeInstanceOf(NotFoundError);
        await waitUntilAdvisoryWaiter();
      },
      async (client) => {
        const updated = await client.query(
          `UPDATE price_list
           SET owner_legal_entity_id = $1, version = version + 1, updated_at = now()
           WHERE id = $2 AND tenant_id = $3 AND owner_legal_entity_id = $4`,
          [leD.id, created2.priceList.id, ctxA.tenantId, leB.id],
        );
        if (updated.rowCount !== 1) throw new Error("failed to transfer on holder");
      },
    );
    await createRejected;
    expect(
      await db.priceListLegalEntityAssignment.count({
        where: { priceListId: created2.priceList.id, legalEntityId: leC.id },
      }),
    ).toBe(0);
    expect(
      await db.auditEvent.count({
        where: { tenantId: ctxA.tenantId, action: "price_list_assignment.created" },
      }),
    ).toBe(auditsBefore);
    expect(transferred2.ownerLegalEntityId).toBe(leB.id);

    const created3 = await createTestPriceList(ctxA, leA.id, "SGD", "Probe");
    const transferAuditsBefore = await db.auditEvent.count({
      where: {
        tenantId: ctxA.tenantId,
        entityId: created3.priceList.id,
        action: "price_list.ownership_transferred",
      },
    });
    let transferDone: Promise<void> | undefined;
    await holdTx(
      ctxAB,
      async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          assignmentKey(ctxA.tenantId, created3.priceList.id),
        ]);
      },
      async () => {
        const pending = transferPriceListOwnership(ctxAB, created3.priceList.id, {
          newOwnerLegalEntityId: leB.id,
          expectedVersion: created3.priceList.version,
        });
        transferDone = expect(pending).resolves.toMatchObject({
          ownerLegalEntityId: leB.id,
        });
        await waitUntilAdvisoryWaiter();
        const stillOwned = await db.priceList.findFirstOrThrow({
          where: { id: created3.priceList.id },
        });
        expect(stillOwned.ownerLegalEntityId).toBe(leA.id);
        expect(
          await db.auditEvent.count({
            where: {
              tenantId: ctxA.tenantId,
              entityId: created3.priceList.id,
              action: "price_list.ownership_transferred",
            },
          }),
        ).toBe(transferAuditsBefore);
      },
    );
    await transferDone;
  });

  it("entry create vs price-list assignment suspend, both orderings", async () => {
    fixture = await setupPricingDomainFixture();
    const { ctxA, ctxAB, leA, leB } = fixture;
    const uom = await createTestUom(ctxA);
    const item = await createTestItem(ctxA, leA.id, uom.id);
    const list = await createTestPriceList(ctxA, leA.id);
    await createPriceListAssignment(ctxAB, {
      priceListId: list.priceList.id,
      legalEntityId: leB.id,
    });
    const db = createSystemClient();
    const createdBefore = await db.auditEvent.count({
      where: { tenantId: ctxA.tenantId, action: "price_list_entry.created" },
    });

    // Create-first: FOR SHARE on the assignment is compatible with create and
    // blocks suspend's FOR UPDATE. Create therefore commits while suspend waits.
    let createDone: Promise<void> | undefined;
    let suspendDone: Promise<void> | undefined;
    await holdTx(
      ctxA,
      async (client) => {
        const locked = await client.query(
          `SELECT id FROM price_list_legal_entity_assignment
           WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
          [list.assignment.id, ctxA.tenantId],
        );
        if (locked.rowCount !== 1) {
          throw new Error("failed to share-lock price-list assignment");
        }
      },
      async () => {
        const pendingCreate = createPriceListEntry(ctxA, {
          priceListAssignmentId: list.assignment.id,
          catalogItemAssignmentId: item.assignment.id,
          unitPrice: "1",
          effectiveFrom: "2026-09-01",
          effectiveTo: "2026-09-30",
        });
        createDone = expect(pendingCreate).resolves.toMatchObject({
          priceListAssignmentId: list.assignment.id,
        });
        const pendingSuspend = updatePriceListAssignment(ctxAB, list.assignment.id, {
          expectedVersion: list.assignment.version,
          status: "SUSPENDED",
        });
        suspendDone = expect(pendingSuspend).resolves.toMatchObject({
          status: "SUSPENDED",
        });
        await waitUntilRowLockWaiter();
        await createDone;
      },
    );
    await suspendDone;
    expect(
      await db.priceListEntry.count({
        where: { priceListAssignmentId: list.assignment.id },
      }),
    ).toBe(1);
    expect(
      await db.auditEvent.count({
        where: { tenantId: ctxA.tenantId, action: "price_list_entry.created" },
      }),
    ).toBe(createdBefore + 1);
    await expect(
      resolveEffectivePrice(ctxA, {
        legalEntityId: leA.id,
        catalogItemId: item.item.id,
        onDate: "2026-09-15",
        priceListId: list.priceList.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Suspend-first is only possible when suspend commits before create takes
    // FOR SHARE. An in-flight create already holding SHARE forces suspend to wait.
    const list2 = await createTestPriceList(ctxA, leA.id, "SGD", "SuspFirst");
    await createPriceListAssignment(ctxAB, {
      priceListId: list2.priceList.id,
      legalEntityId: leB.id,
    });
    const suspended = await updatePriceListAssignment(ctxAB, list2.assignment.id, {
      expectedVersion: list2.assignment.version,
      status: "SUSPENDED",
    });
    expect(suspended.status).toBe("SUSPENDED");
    const createdBeforeReject = await db.auditEvent.count({
      where: { tenantId: ctxA.tenantId, action: "price_list_entry.created" },
    });
    await expect(
      createPriceListEntry(ctxA, {
        priceListAssignmentId: list2.assignment.id,
        catalogItemAssignmentId: item.assignment.id,
        unitPrice: "1",
        effectiveFrom: "2026-10-01",
        effectiveTo: "2026-10-31",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(
      await db.priceListEntry.count({
        where: { priceListAssignmentId: list2.assignment.id },
      }),
    ).toBe(0);
    expect(
      await db.auditEvent.count({
        where: { tenantId: ctxA.tenantId, action: "price_list_entry.created" },
      }),
    ).toBe(createdBeforeReject);

    const events = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) =>
        tx.auditEvent.findMany({
          where: { tenantId: ctxA.tenantId },
          orderBy: { sequence: "asc" },
        }),
    );
    expect(verifyAuditChain(toAuditLinks(events)).valid).toBe(true);
  });

  it("entry create vs catalog-item assignment suspend, both orderings", async () => {
    fixture = await setupPricingDomainFixture();
    const { ctxA, ctxAB, leA, leB } = fixture;
    const uom = await createTestUom(ctxA);
    const item = await createTestItem(ctxA, leA.id, uom.id);
    await createCatalogItemAssignment(ctxAB, {
      catalogItemId: item.item.id,
      legalEntityId: leB.id,
    });
    const list = await createTestPriceList(ctxA, leA.id);
    const db = createSystemClient();
    const createdBefore = await db.auditEvent.count({
      where: { tenantId: ctxA.tenantId, action: "price_list_entry.created" },
    });

    let createDone: Promise<void> | undefined;
    let suspendDone: Promise<void> | undefined;
    await holdTx(
      ctxA,
      async (client) => {
        const locked = await client.query(
          `SELECT id FROM catalog_item_legal_entity_assignment
           WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
          [item.assignment.id, ctxA.tenantId],
        );
        if (locked.rowCount !== 1) {
          throw new Error("failed to share-lock catalog-item assignment");
        }
      },
      async () => {
        const pendingCreate = createPriceListEntry(ctxA, {
          priceListAssignmentId: list.assignment.id,
          catalogItemAssignmentId: item.assignment.id,
          unitPrice: "1",
          effectiveFrom: "2026-09-01",
          effectiveTo: "2026-09-30",
        });
        createDone = expect(pendingCreate).resolves.toMatchObject({
          catalogItemAssignmentId: item.assignment.id,
        });
        const pendingSuspend = updateCatalogItemAssignment(ctxAB, item.assignment.id, {
          expectedVersion: item.assignment.version,
          status: "SUSPENDED",
        });
        suspendDone = expect(pendingSuspend).resolves.toMatchObject({
          status: "SUSPENDED",
        });
        await waitUntilRowLockWaiter();
        await createDone;
      },
    );
    await suspendDone;
    expect(
      await db.priceListEntry.count({
        where: { catalogItemAssignmentId: item.assignment.id },
      }),
    ).toBe(1);
    expect(
      await db.auditEvent.count({
        where: { tenantId: ctxA.tenantId, action: "price_list_entry.created" },
      }),
    ).toBe(createdBefore + 1);
    await expect(
      resolveEffectivePrice(ctxA, {
        legalEntityId: leA.id,
        catalogItemId: item.item.id,
        onDate: "2026-09-15",
        priceListId: list.priceList.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const item2 = await createTestItem(ctxA, leA.id, uom.id, "Item2");
    await createCatalogItemAssignment(ctxAB, {
      catalogItemId: item2.item.id,
      legalEntityId: leB.id,
    });
    const suspendedItem = await updateCatalogItemAssignment(ctxAB, item2.assignment.id, {
      expectedVersion: item2.assignment.version,
      status: "SUSPENDED",
    });
    expect(suspendedItem.status).toBe("SUSPENDED");
    const createdBeforeReject = await db.auditEvent.count({
      where: { tenantId: ctxA.tenantId, action: "price_list_entry.created" },
    });
    await expect(
      createPriceListEntry(ctxA, {
        priceListAssignmentId: list.assignment.id,
        catalogItemAssignmentId: item2.assignment.id,
        unitPrice: "1",
        effectiveFrom: "2026-10-01",
        effectiveTo: "2026-10-31",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(
      await db.priceListEntry.count({
        where: { catalogItemAssignmentId: item2.assignment.id },
      }),
    ).toBe(0);
    expect(
      await db.auditEvent.count({
        where: { tenantId: ctxA.tenantId, action: "price_list_entry.created" },
      }),
    ).toBe(createdBeforeReject);

    const events = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) =>
        tx.auditEvent.findMany({
          where: { tenantId: ctxA.tenantId },
          orderBy: { sequence: "asc" },
        }),
    );
    expect(verifyAuditChain(toAuditLinks(events)).valid).toBe(true);
  });

  it("close vs close, update vs close, and gapless audit", async () => {
    fixture = await setupPricingDomainFixture();
    const { ctxA, ctxAB, leA, leB } = fixture;
    const uom = await createTestUom(ctxA);
    const item = await createTestItem(ctxA, leA.id, uom.id);
    const list = await createTestPriceList(ctxA, leA.id);
    await createPriceListAssignment(ctxAB, {
      priceListId: list.priceList.id,
      legalEntityId: leB.id,
    });

    const open = await createPriceListEntry(ctxA, {
      priceListAssignmentId: list.assignment.id,
      catalogItemAssignmentId: item.assignment.id,
      unitPrice: "2",
      effectiveFrom: "2026-11-01",
      effectiveTo: null,
    });
    const closeSettled = await Promise.allSettled([
      closePriceListEntry(ctxA, open.id, {
        expectedVersion: open.version,
        effectiveTo: "2026-11-15",
      }),
      closePriceListEntry(ctxA, open.id, {
        expectedVersion: open.version,
        effectiveTo: "2026-11-20",
      }),
    ]);
    expect(closeSettled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const stale = closeSettled.find((r) => r.status === "rejected");
    if (stale?.status === "rejected") {
      expect(stale.reason).toBeInstanceOf(StaleVersionError);
    }
    await expect(
      createPriceListEntry(ctxA, {
        priceListAssignmentId: open.priceListAssignmentId,
        catalogItemAssignmentId: open.catalogItemAssignmentId,
        unitPrice: "3",
        effectiveFrom: "2026-11-16",
        effectiveTo: null,
      }),
    ).resolves.toBeTruthy();

    const events = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) =>
        tx.auditEvent.findMany({
          where: { tenantId: ctxA.tenantId },
          orderBy: { sequence: "asc" },
        }),
    );
    expect(verifyAuditChain(toAuditLinks(events)).valid).toBe(true);
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => BigInt(i + 1)));

    const beforeCount = events.length;
    await expect(
      createPriceListAssignment(ctxAB, {
        priceListId: list.priceList.id,
        legalEntityId: leB.id,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    const afterFail = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) =>
        tx.auditEvent.findMany({
          where: { tenantId: ctxA.tenantId },
          orderBy: { sequence: "asc" },
        }),
    );
    expect(afterFail).toHaveLength(beforeCount);

    const listU = await createTestPriceList(ctxA, leA.id, "SGD", "Upd");
    const itemU = await createTestItem(ctxA, leA.id, uom.id, "ItemU");
    const toRace = await createPriceListEntry(ctxA, {
      priceListAssignmentId: listU.assignment.id,
      catalogItemAssignmentId: itemU.assignment.id,
      unitPrice: "4",
      effectiveFrom: "2026-12-01",
      effectiveTo: "2026-12-31",
    });
    const updateClose = await Promise.allSettled([
      updatePriceListEntry(ctxA, toRace.id, {
        expectedVersion: toRace.version,
        unitPrice: "5",
      }),
      closePriceListEntry(ctxA, toRace.id, {
        expectedVersion: toRace.version,
        effectiveTo: "2026-12-15",
      }),
    ]);
    expect(updateClose.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});
