import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { verifyAuditChain, type AuditChainLink } from "@noahark/audit";
import type { AccessContext } from "@noahark/core";
import {
  ConflictError,
  NotFoundError,
  StaleVersionError,
  ValidationError,
} from "@noahark/core";
import { createSystemClient } from "@noahark/db/system";
import { withTenantContext } from "@noahark/db";
import {
  archiveCatalogItemAssignment,
  createCatalogCategory,
  createCatalogItem,
  createCatalogItemAssignment,
  createUnitOfMeasure,
  deactivateCatalogCategory,
  deactivateUnitOfMeasure,
  transferCatalogItemOwnership,
  updateCatalogItem,
  updateCatalogItemAssignment,
} from "@noahark/catalog";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  catalogCode,
  contextWithEntities,
  createTestCategory,
  createTestUom,
  setupCatalogDomainFixture,
  type CatalogDomainFixture,
} from "./catalogDomainFixture";

function advisoryKey(tenantId: string, catalogItemId: string): string {
  return `catalog-item-assignments:${tenantId}:${catalogItemId}`;
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

async function insertItemOnClient(
  client: pg.Client,
  args: {
    tenantId: string;
    ownerLegalEntityId: string;
    code: string;
    name: string;
    categoryId: string | null;
    baseUomId: string;
  },
): Promise<string> {
  const itemId = `ci_${randomBytes(12).toString("hex")}`;
  const assignmentId = `ca_${randomBytes(12).toString("hex")}`;
  await client.query(
    `INSERT INTO catalog_item (
       id, tenant_id, owner_legal_entity_id, code, item_type, name,
       category_id, base_uom_id, is_sellable, is_purchasable, status, version,
       created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'PRODUCT',$5,$6,$7,true,true,'ACTIVE',1,now(),now())`,
    [
      itemId,
      args.tenantId,
      args.ownerLegalEntityId,
      args.code,
      args.name,
      args.categoryId,
      args.baseUomId,
    ],
  );
  await client.query(
    `INSERT INTO catalog_item_legal_entity_assignment (
       id, tenant_id, catalog_item_id, legal_entity_id, status, version,
       assigned_at, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'ACTIVE',1,now(),now(),now())`,
    [assignmentId, args.tenantId, itemId, args.ownerLegalEntityId],
  );
  return itemId;
}

describe("P2C.1 — catalog concurrency races", () => {
  let fixture: CatalogDomainFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("C-1 C-4 duplicate codes: one winner each", async () => {
    fixture = await setupCatalogDomainFixture();
    const { ctxA, leA } = fixture;
    const uom = await createTestUom(ctxA);
    const itemCode = catalogCode("SKU");
    const settled = await Promise.allSettled([
      createCatalogItem(ctxA, {
        ownerLegalEntityId: leA.id,
        code: itemCode,
        itemType: "PRODUCT",
        name: "One",
        baseUomId: uom.id,
      }),
      createCatalogItem(ctxA, {
        ownerLegalEntityId: leA.id,
        code: itemCode,
        itemType: "PRODUCT",
        name: "Two",
        baseUomId: uom.id,
      }),
    ]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((r) => r.status === "rejected")[0]?.reason).toBeInstanceOf(
      ConflictError,
    );
    const db = createSystemClient();
    expect(
      await db.catalogItem.count({
        where: { tenantId: ctxA.tenantId, code: itemCode },
      }),
    ).toBe(1);

    const catCode = catalogCode("CAT");
    const catSettled = await Promise.allSettled([
      createCatalogCategory(ctxA, { code: catCode, name: "A" }),
      createCatalogCategory(ctxA, { code: catCode, name: "B" }),
    ]);
    expect(catSettled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(catSettled.filter((r) => r.status === "rejected")[0]?.reason).toBeInstanceOf(
      ConflictError,
    );
    const uomCode = catalogCode("UOM");
    const uomSettled = await Promise.allSettled([
      createUnitOfMeasure(ctxA, { code: uomCode, name: "A" }),
      createUnitOfMeasure(ctxA, { code: uomCode, name: "B" }),
    ]);
    expect(uomSettled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(uomSettled.filter((r) => r.status === "rejected")[0]?.reason).toBeInstanceOf(
      ConflictError,
    );
  });

  it("C-2 C-3 duplicate assignment and entityItemCode", async () => {
    fixture = await setupCatalogDomainFixture();
    const { ctxA, ctxAB, leA, leB, leC } = fixture;
    const uom = await createTestUom(ctxA);
    const item = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Dup assign",
      baseUomId: uom.id,
    });
    const dupEntity = await Promise.allSettled([
      createCatalogItemAssignment(ctxAB, {
        catalogItemId: item.item.id,
        legalEntityId: leB.id,
      }),
      createCatalogItemAssignment(ctxAB, {
        catalogItemId: item.item.id,
        legalEntityId: leB.id,
      }),
    ]);
    expect(dupEntity.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(dupEntity.filter((r) => r.status === "rejected")[0]?.reason).toBeInstanceOf(
      ConflictError,
    );

    const other = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Code dup",
      baseUomId: uom.id,
    });
    const codeSettled = await Promise.allSettled([
      createCatalogItemAssignment(ctxAB, {
        catalogItemId: item.item.id,
        legalEntityId: leC.id,
        entityItemCode: "SAME",
      }),
      createCatalogItemAssignment(ctxAB, {
        catalogItemId: other.item.id,
        legalEntityId: leC.id,
        entityItemCode: "SAME",
      }),
    ]);
    expect(codeSettled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(codeSettled.filter((r) => r.status === "rejected")[0]?.reason).toBeInstanceOf(
      ConflictError,
    );
  });

  it("C-5 C-6 stale versions", async () => {
    fixture = await setupCatalogDomainFixture();
    const { ctxA, ctxAB, leA, leB } = fixture;
    const uom = await createTestUom(ctxA);
    const item = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Stale",
      baseUomId: uom.id,
    });
    const staleItem = await Promise.allSettled([
      updateCatalogItem(ctxA, item.item.id, {
        expectedVersion: item.item.version,
        name: "A",
      }),
      updateCatalogItem(ctxA, item.item.id, {
        expectedVersion: item.item.version,
        name: "B",
      }),
    ]);
    expect(staleItem.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(staleItem.filter((r) => r.status === "rejected")[0]?.reason).toBeInstanceOf(
      StaleVersionError,
    );
    const assignB = await createCatalogItemAssignment(ctxAB, {
      catalogItemId: item.item.id,
      legalEntityId: leB.id,
    });
    const staleAssign = await Promise.allSettled([
      updateCatalogItemAssignment(ctxAB, assignB.id, {
        expectedVersion: assignB.version,
        entityItemCode: "X1",
      }),
      updateCatalogItemAssignment(ctxAB, assignB.id, {
        expectedVersion: assignB.version,
        entityItemCode: "X2",
      }),
    ]);
    expect(staleAssign.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(staleAssign.filter((r) => r.status === "rejected")[0]?.reason).toBeInstanceOf(
      StaleVersionError,
    );
  });

  it("C-7 concurrent archive of two assignments leaves at least one ACTIVE", async () => {
    fixture = await setupCatalogDomainFixture();
    const { ctxA, ctxAB, leA, leB } = fixture;
    const uom = await createTestUom(ctxA);
    const item = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Two assigns",
      baseUomId: uom.id,
    });
    const assignB = await createCatalogItemAssignment(ctxAB, {
      catalogItemId: item.item.id,
      legalEntityId: leB.id,
    });
    const settled = await Promise.allSettled([
      archiveCatalogItemAssignment(ctxAB, item.assignment.id, item.assignment.version),
      archiveCatalogItemAssignment(ctxAB, assignB.id, assignB.version),
    ]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((r) => r.status === "rejected")[0]?.reason).toBeInstanceOf(
      ConflictError,
    );
    const db = createSystemClient();
    expect(
      await db.catalogItemLegalEntityAssignment.count({
        where: { catalogItemId: item.item.id, status: "ACTIVE" },
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  it("C-8 category deactivate vs item create, both orders (1-A)", async () => {
    fixture = await setupCatalogDomainFixture();
    const { ctxA, leA } = fixture;
    const category = await createTestCategory(ctxA);
    const uom = await createTestUom(ctxA);

    let createRejected: Promise<void> | undefined;
    await holdTx(
      ctxA,
      async (client) => {
        const locked = await client.query(
          "SELECT id FROM catalog_category WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
          [category.id, ctxA.tenantId],
        );
        if (locked.rowCount !== 1) throw new Error("failed to lock category");
      },
      async () => {
        const pending = createCatalogItem(ctxA, {
          ownerLegalEntityId: leA.id,
          code: catalogCode("SKU"),
          itemType: "PRODUCT",
          name: "Deactivate first",
          categoryId: category.id,
          baseUomId: uom.id,
        });
        createRejected = expect(pending).rejects.toBeInstanceOf(ValidationError);
        await waitUntilRowLockWaiter();
      },
      async (client) => {
        await client.query(
          `UPDATE catalog_category
           SET is_active = false, version = version + 1, updated_at = now()
           WHERE id = $1 AND tenant_id = $2`,
          [category.id, ctxA.tenantId],
        );
      },
    );
    await createRejected;
    const db = createSystemClient();
    expect(
      await db.catalogItem.count({
        where: { tenantId: ctxA.tenantId, name: "Deactivate first" },
      }),
    ).toBe(0);

    const cat2 = await createTestCategory(ctxA);
    let deactivateDone: Promise<void> | undefined;
    let createdId = "";
    await holdTx(
      ctxA,
      async (client) => {
        const locked = await client.query(
          "SELECT id FROM catalog_category WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
          [cat2.id, ctxA.tenantId],
        );
        if (locked.rowCount !== 1) throw new Error("failed to lock category");
      },
      async () => {
        const pending = deactivateCatalogCategory(ctxA, cat2.id, {
          expectedVersion: cat2.version,
        });
        deactivateDone = expect(pending).resolves.toMatchObject({ isActive: false });
        await waitUntilRowLockWaiter();
      },
      async (client) => {
        createdId = await insertItemOnClient(client, {
          tenantId: ctxA.tenantId,
          ownerLegalEntityId: leA.id,
          code: catalogCode("SKU"),
          name: "Create first 1-A",
          categoryId: cat2.id,
          baseUomId: uom.id,
        });
      },
    );
    await deactivateDone;
    const row = await db.catalogItem.findFirst({ where: { id: createdId } });
    expect(row?.categoryId).toBe(cat2.id);
    const catAfter = await db.catalogCategory.findFirst({ where: { id: cat2.id } });
    expect(catAfter?.isActive).toBe(false);
  });

  it("C-9 UOM deactivate vs item create, both orders (1-A)", async () => {
    fixture = await setupCatalogDomainFixture();
    const { ctxA, leA } = fixture;
    const uom = await createTestUom(ctxA);
    let createRejected: Promise<void> | undefined;
    await holdTx(
      ctxA,
      async (client) => {
        const locked = await client.query(
          "SELECT id FROM unit_of_measure WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
          [uom.id, ctxA.tenantId],
        );
        if (locked.rowCount !== 1) throw new Error("failed to lock uom");
      },
      async () => {
        const pending = createCatalogItem(ctxA, {
          ownerLegalEntityId: leA.id,
          code: catalogCode("SKU"),
          itemType: "PRODUCT",
          name: "UOM deactivate first",
          baseUomId: uom.id,
        });
        createRejected = expect(pending).rejects.toBeInstanceOf(ValidationError);
        await waitUntilRowLockWaiter();
      },
      async (client) => {
        await client.query(
          `UPDATE unit_of_measure
           SET is_active = false, version = version + 1, updated_at = now()
           WHERE id = $1 AND tenant_id = $2`,
          [uom.id, ctxA.tenantId],
        );
      },
    );
    await createRejected;
    const db = createSystemClient();
    expect(
      await db.catalogItem.count({
        where: { tenantId: ctxA.tenantId, name: "UOM deactivate first" },
      }),
    ).toBe(0);

    const uom2 = await createTestUom(ctxA);
    let deactivateDone: Promise<void> | undefined;
    let createdId = "";
    await holdTx(
      ctxA,
      async (client) => {
        const locked = await client.query(
          "SELECT id FROM unit_of_measure WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
          [uom2.id, ctxA.tenantId],
        );
        if (locked.rowCount !== 1) throw new Error("failed to lock uom");
      },
      async () => {
        const pending = deactivateUnitOfMeasure(ctxA, uom2.id, {
          expectedVersion: uom2.version,
        });
        deactivateDone = expect(pending).resolves.toMatchObject({ isActive: false });
        await waitUntilRowLockWaiter();
      },
      async (client) => {
        createdId = await insertItemOnClient(client, {
          tenantId: ctxA.tenantId,
          ownerLegalEntityId: leA.id,
          code: catalogCode("SKU"),
          name: "UOM create first 1-A",
          categoryId: null,
          baseUomId: uom2.id,
        });
      },
    );
    await deactivateDone;
    const row = await db.catalogItem.findFirst({ where: { id: createdId } });
    expect(row?.baseUomId).toBe(uom2.id);
  });

  it("C-10 C-11 deactivate vs update that changes vs echoes a category", async () => {
    fixture = await setupCatalogDomainFixture();
    const { ctxA, leA } = fixture;
    const current = await createTestCategory(ctxA);
    const target = await createTestCategory(ctxA);
    const uom = await createTestUom(ctxA);
    const item = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Ref race",
      categoryId: current.id,
      baseUomId: uom.id,
    });

    let changeRejected: Promise<void> | undefined;
    await holdTx(
      ctxA,
      async (client) => {
        const locked = await client.query(
          "SELECT id FROM catalog_category WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
          [target.id, ctxA.tenantId],
        );
        if (locked.rowCount !== 1) throw new Error("failed to lock target category");
      },
      async () => {
        const pending = updateCatalogItem(ctxA, item.item.id, {
          expectedVersion: item.item.version,
          categoryId: target.id,
        });
        changeRejected = expect(pending).rejects.toBeInstanceOf(ValidationError);
        await waitUntilRowLockWaiter();
      },
      async (client) => {
        await client.query(
          `UPDATE catalog_category
           SET is_active = false, version = version + 1, updated_at = now()
           WHERE id = $1 AND tenant_id = $2`,
          [target.id, ctxA.tenantId],
        );
      },
    );
    await changeRejected;
    const db = createSystemClient();
    const unchanged = await db.catalogItem.findFirstOrThrow({
      where: { id: item.item.id },
    });
    expect(unchanged.version).toBe(item.item.version);
    expect(unchanged.categoryId).toBe(current.id);
    expect(
      await db.auditEvent.count({
        where: {
          tenantId: ctxA.tenantId,
          entityId: item.item.id,
          action: "catalog_item.updated",
        },
      }),
    ).toBe(0);

    const target2 = await createTestCategory(ctxA);
    let deactivateDone: Promise<void> | undefined;
    await holdTx(
      ctxA,
      async (client) => {
        const locked = await client.query(
          "SELECT id FROM catalog_category WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
          [target2.id, ctxA.tenantId],
        );
        if (locked.rowCount !== 1) throw new Error("failed to lock target2");
      },
      async () => {
        const pending = deactivateCatalogCategory(ctxA, target2.id, {
          expectedVersion: target2.version,
        });
        deactivateDone = expect(pending).resolves.toMatchObject({ isActive: false });
        await waitUntilRowLockWaiter();
      },
      async (client) => {
        await client.query(
          `UPDATE catalog_item
           SET category_id = $1, version = version + 1, updated_at = now()
           WHERE id = $2 AND tenant_id = $3`,
          [target2.id, item.item.id, ctxA.tenantId],
        );
      },
    );
    await deactivateDone;
    const afterChange = await db.catalogItem.findFirstOrThrow({
      where: { id: item.item.id },
    });
    expect(afterChange.categoryId).toBe(target2.id);

    const echoCat = await createTestCategory(ctxA);
    const echoItem = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Echo",
      categoryId: echoCat.id,
      baseUomId: uom.id,
    });
    const [echoed, deactivated] = await Promise.all([
      updateCatalogItem(ctxA, echoItem.item.id, {
        expectedVersion: echoItem.item.version,
        categoryId: echoCat.id,
        name: "Echoed",
      }),
      deactivateCatalogCategory(ctxA, echoCat.id, { expectedVersion: echoCat.version }),
    ]);
    expect(echoed.categoryId).toBe(echoCat.id);
    expect(deactivated.isActive).toBe(false);

    const echo2 = await createTestCategory(ctxA);
    const echoItem2 = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Echo2",
      categoryId: echo2.id,
      baseUomId: uom.id,
    });
    await deactivateCatalogCategory(ctxA, echo2.id, { expectedVersion: echo2.version });
    const echoedAfter = await updateCatalogItem(ctxA, echoItem2.item.id, {
      expectedVersion: echoItem2.item.version,
      categoryId: echo2.id,
    });
    expect(echoedAfter.categoryId).toBe(echo2.id);
  });

  it("C-12 C-13 transfer vs update and two transfers", async () => {
    fixture = await setupCatalogDomainFixture();
    const { ctxA, ctxAB, leA, leB, leD } = fixture;
    const uom = await createTestUom(ctxA);
    const item = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Lock row",
      baseUomId: uom.id,
    });
    const vsUpdate = await Promise.allSettled([
      transferCatalogItemOwnership(ctxAB, item.item.id, {
        newOwnerLegalEntityId: leB.id,
        expectedVersion: item.item.version,
      }),
      updateCatalogItem(ctxAB, item.item.id, {
        expectedVersion: item.item.version,
        name: "Renamed",
      }),
    ]);
    expect(vsUpdate.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(vsUpdate.filter((r) => r.status === "rejected")[0]?.reason).toBeInstanceOf(
      StaleVersionError,
    );

    const item2 = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Two transfers",
      baseUomId: uom.id,
    });
    const ctxABD = contextWithEntities(ctxAB, [leA.id, leB.id, leD.id]);
    const two = await Promise.allSettled([
      transferCatalogItemOwnership(ctxABD, item2.item.id, {
        newOwnerLegalEntityId: leB.id,
        expectedVersion: item2.item.version,
      }),
      transferCatalogItemOwnership(ctxABD, item2.item.id, {
        newOwnerLegalEntityId: leD.id,
        expectedVersion: item2.item.version,
      }),
    ]);
    expect(two.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const db = createSystemClient();
    const owners = await db.catalogItem.findMany({
      where: { id: item2.item.id },
    });
    expect(owners).toHaveLength(1);
    expect([leB.id, leD.id]).toContain(owners[0]?.ownerLegalEntityId);
  });

  it("C-14 C-15 assignment create vs archive and vs non-transfer update", async () => {
    fixture = await setupCatalogDomainFixture();
    const { ctxA, ctxAB, leA, leB } = fixture;
    const uom = await createTestUom(ctxA);
    const item = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Create vs archive",
      baseUomId: uom.id,
    });
    const settled = await Promise.allSettled([
      createCatalogItemAssignment(ctxAB, {
        catalogItemId: item.item.id,
        legalEntityId: leB.id,
      }),
      archiveCatalogItemAssignment(ctxA, item.assignment.id, item.assignment.version),
    ]);
    const db = createSystemClient();
    expect(
      await db.catalogItemLegalEntityAssignment.count({
        where: { catalogItemId: item.item.id, status: "ACTIVE" },
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(settled.some((r) => r.status === "fulfilled")).toBe(true);

    const item2 = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Non blocking",
      baseUomId: uom.id,
    });
    const [assign, updated] = await Promise.all([
      createCatalogItemAssignment(ctxAB, {
        catalogItemId: item2.item.id,
        legalEntityId: leB.id,
      }),
      updateCatalogItem(ctxA, item2.item.id, {
        expectedVersion: item2.item.version,
        name: "Updated concurrently",
      }),
    ]);
    expect(assign.status).toBe("ACTIVE");
    expect(updated.name).toBe("Updated concurrently");
  });

  it("C-16 C-17 audit chain gapless; rollback writes no event", async () => {
    fixture = await setupCatalogDomainFixture();
    const { ctxA, ctxAB, leA, leB } = fixture;
    const uom = await createTestUom(ctxA);
    const created = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Audit",
      baseUomId: uom.id,
    });
    await updateCatalogItem(ctxA, created.item.id, {
      expectedVersion: created.item.version,
      name: "Audit 2",
    });
    await transferCatalogItemOwnership(ctxAB, created.item.id, {
      newOwnerLegalEntityId: leB.id,
      expectedVersion: created.item.version + 1,
    });

    const events = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) =>
        tx.auditEvent.findMany({
          where: { tenantId: ctxA.tenantId },
          orderBy: { sequence: "asc" },
        }),
    );
    const result = verifyAuditChain(toAuditLinks(events));
    expect(result.valid).toBe(true);
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => BigInt(i + 1)));
    const catalogEvents = events.filter((e) => e.action.startsWith("catalog_"));
    expect(catalogEvents.length).toBeGreaterThan(0);

    const beforeCount = events.length;
    const lastHash = events[events.length - 1]?.hash;
    await expect(
      createCatalogItem(ctxA, {
        ownerLegalEntityId: leA.id,
        code: created.item.code,
        itemType: "PRODUCT",
        name: "Rollback",
        baseUomId: uom.id,
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
    const recovered = await createCatalogCategory(ctxA, {
      code: catalogCode("CAT"),
      name: "After fail",
    });
    expect(recovered.id).toBeTruthy();
    const afterOk = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) =>
        tx.auditEvent.findMany({
          where: { tenantId: ctxA.tenantId },
          orderBy: { sequence: "asc" },
        }),
    );
    expect(afterOk[afterOk.length - 1]?.prevHash).toBe(lastHash);
    expect(verifyAuditChain(toAuditLinks(afterOk)).valid).toBe(true);
  });

  it("C-18 assignment create vs ownership transfer, both orders", async () => {
    fixture = await setupCatalogDomainFixture();
    const { ctxA, ctxAB, leA, leB, leC, leD } = fixture;
    const uom = await createTestUom(ctxA);
    const created = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "TOCTOU A",
      baseUomId: uom.id,
    });
    const transferred = await transferCatalogItemOwnership(ctxAB, created.item.id, {
      newOwnerLegalEntityId: leB.id,
      expectedVersion: created.item.version,
    });
    const db = createSystemClient();
    const seedAssigns = await db.catalogItemLegalEntityAssignment.findMany({
      where: { catalogItemId: created.item.id, status: "ACTIVE" },
    });
    expect(seedAssigns.map((row) => row.legalEntityId)).toEqual([leA.id]);
    expect(transferred.ownerLegalEntityId).toBe(leB.id);

    const ctxBC = contextWithEntities(ctxAB, [leB.id, leC.id]);
    const ctxBD = contextWithEntities(ctxAB, [leB.id, leD.id]);

    let createDone: Promise<void> | undefined;
    await holdTx(
      ctxBC,
      async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          advisoryKey(ctxA.tenantId, created.item.id),
        ]);
      },
      async () => {
        const pending = createCatalogItemAssignment(ctxBC, {
          catalogItemId: created.item.id,
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
    const afterCreate = await transferCatalogItemOwnership(ctxBD, created.item.id, {
      newOwnerLegalEntityId: leD.id,
      expectedVersion: transferred.version,
    });
    expect(afterCreate.ownerLegalEntityId).toBe(leD.id);
    const cAssign = await db.catalogItemLegalEntityAssignment.findFirst({
      where: {
        catalogItemId: created.item.id,
        legalEntityId: leC.id,
        status: "ACTIVE",
      },
    });
    expect(cAssign).not.toBeNull();
    const chainA = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) =>
        tx.auditEvent.findMany({
          where: { tenantId: ctxA.tenantId },
          orderBy: { sequence: "asc" },
        }),
    );
    expect(verifyAuditChain(toAuditLinks(chainA)).valid).toBe(true);

    const created2 = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "TOCTOU B",
      baseUomId: uom.id,
    });
    const transferred2 = await transferCatalogItemOwnership(ctxAB, created2.item.id, {
      newOwnerLegalEntityId: leB.id,
      expectedVersion: created2.item.version,
    });
    const seed2 = await db.catalogItemLegalEntityAssignment.findMany({
      where: { catalogItemId: created2.item.id, status: "ACTIVE" },
    });
    expect(seed2.map((row) => row.legalEntityId)).toEqual([leA.id]);

    const auditsBefore = await db.auditEvent.count({
      where: {
        tenantId: ctxA.tenantId,
        action: "catalog_item_assignment.created",
      },
    });
    let createRejected: Promise<void> | undefined;
    await holdTx(
      ctxBD,
      async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          advisoryKey(ctxA.tenantId, created2.item.id),
        ]);
      },
      async () => {
        const pending = createCatalogItemAssignment(ctxBC, {
          catalogItemId: created2.item.id,
          legalEntityId: leC.id,
        });
        createRejected = expect(pending).rejects.toBeInstanceOf(NotFoundError);
        await waitUntilAdvisoryWaiter();
      },
      async (client) => {
        const updated = await client.query(
          `UPDATE catalog_item
           SET owner_legal_entity_id = $1, version = version + 1, updated_at = now()
           WHERE id = $2 AND tenant_id = $3 AND owner_legal_entity_id = $4`,
          [leD.id, created2.item.id, ctxA.tenantId, leB.id],
        );
        if (updated.rowCount !== 1) throw new Error("failed to transfer on holder");
      },
    );
    await createRejected;
    expect(
      await db.catalogItemLegalEntityAssignment.count({
        where: { catalogItemId: created2.item.id, legalEntityId: leC.id },
      }),
    ).toBe(0);
    expect(
      await db.auditEvent.count({
        where: {
          tenantId: ctxA.tenantId,
          action: "catalog_item_assignment.created",
        },
      }),
    ).toBe(auditsBefore);
    expect(transferred2.ownerLegalEntityId).toBe(leB.id);
  });

  it("C-18 supplementary: production transferCatalogItemOwnership waits on the shared advisory key", async () => {
    fixture = await setupCatalogDomainFixture();
    const { ctxA, ctxAB, leA, leB } = fixture;
    const uom = await createTestUom(ctxA);
    const created = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Transfer lock probe",
      baseUomId: uom.id,
    });
    const db = createSystemClient();
    const assignmentSnapshot = await db.catalogItemLegalEntityAssignment.findMany({
      where: { catalogItemId: created.item.id },
      orderBy: { id: "asc" },
    });
    const transferAuditsBefore = await db.auditEvent.count({
      where: {
        tenantId: ctxA.tenantId,
        entityId: created.item.id,
        action: "catalog_item.ownership_transferred",
      },
    });

    let transferDone: Promise<void> | undefined;
    await holdTx(
      ctxAB,
      async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          advisoryKey(ctxA.tenantId, created.item.id),
        ]);
      },
      async () => {
        const pending = transferCatalogItemOwnership(ctxAB, created.item.id, {
          newOwnerLegalEntityId: leB.id,
          expectedVersion: created.item.version,
        });
        transferDone = expect(pending).resolves.toMatchObject({
          ownerLegalEntityId: leB.id,
          version: created.item.version + 1,
        });
        await waitUntil(
          `SELECT count(*)::text AS n
           FROM pg_locks
           WHERE locktype = 'advisory' AND NOT granted`,
          "production transfer blocked on the shared advisory key",
        );
        const stillOwned = await db.catalogItem.findFirstOrThrow({
          where: { id: created.item.id },
        });
        expect(stillOwned.ownerLegalEntityId).toBe(leA.id);
        expect(stillOwned.version).toBe(created.item.version);
        expect(
          await db.auditEvent.count({
            where: {
              tenantId: ctxA.tenantId,
              entityId: created.item.id,
              action: "catalog_item.ownership_transferred",
            },
          }),
        ).toBe(transferAuditsBefore);
      },
    );
    await transferDone;

    const after = await db.catalogItem.findFirstOrThrow({
      where: { id: created.item.id },
    });
    expect(after.ownerLegalEntityId).toBe(leB.id);
    expect(after.version).toBe(created.item.version + 1);
    const assignsAfter = await db.catalogItemLegalEntityAssignment.findMany({
      where: { catalogItemId: created.item.id },
      orderBy: { id: "asc" },
    });
    expect(assignsAfter.map((row) => row.id)).toEqual(
      assignmentSnapshot.map((row) => row.id),
    );
    expect(assignsAfter.map((row) => row.legalEntityId)).toEqual(
      assignmentSnapshot.map((row) => row.legalEntityId),
    );
    expect(
      await db.auditEvent.count({
        where: {
          tenantId: ctxA.tenantId,
          entityId: created.item.id,
          action: "catalog_item.ownership_transferred",
        },
      }),
    ).toBe(transferAuditsBefore + 1);
    const chain = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) =>
        tx.auditEvent.findMany({
          where: { tenantId: ctxA.tenantId },
          orderBy: { sequence: "asc" },
        }),
    );
    expect(verifyAuditChain(toAuditLinks(chain)).valid).toBe(true);
  });
});
