import { afterEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { UnauthenticatedError } from "@noahark/core";
import type { AccessContext } from "@noahark/core";
import { AUDIT_ACTIONS, verifyAuditChain } from "@noahark/audit";
import { PERMISSIONS } from "@noahark/authz";
import { withTenantContext } from "@noahark/db";
import { createSystemClient } from "@noahark/db/system";
import {
  createCatalogItem,
  createCatalogItemAssignment,
  transferCatalogItemOwnership,
} from "@/lib/services/catalogDomain";
import { POST as itemTransfer } from "@/app/api/v1/tenants/[tenantId]/catalog/items/[catalogItemId]/ownership-transfer/route";
import { POST as assignmentsPost } from "@/app/api/v1/tenants/[tenantId]/catalog/item-assignments/route";
import { POST as assignmentArchive } from "@/app/api/v1/tenants/[tenantId]/catalog/item-assignments/[assignmentId]/archive/route";
import {
  addTenantMember,
  assignRoleDirect,
  cleanupTenant,
  cleanupUser,
  createTestUser,
  grantLegalEntityAccessDirect,
  uniqueSlug,
} from "./testHelpers";
import {
  catalogCode,
  createTestUom,
  setupCatalogDomainFixture,
  type CatalogDomainFixture,
} from "./catalogDomainFixture";

const { catalogApiAuth } = vi.hoisted(() => ({
  catalogApiAuth: { userId: undefined as string | undefined },
}));

vi.mock("@/lib/context", async (importOriginal) => {
  const actual = (await importOriginal()) as {
    getAccessContext: (
      userId: string,
      tenantId: string,
      meta: {
        requestId: string;
        ipAddress?: string | undefined;
        userAgent?: string | undefined;
      },
    ) => Promise<unknown>;
    requestMeta: (
      req: Request,
      requestId: string,
    ) => {
      requestId: string;
      ipAddress?: string | undefined;
      userAgent?: string | undefined;
    };
  };
  return {
    ...actual,
    resolveTenantContext: async (req: Request, requestId: string, tenantId: string) => {
      const actor = req.headers.get("x-test-actor") ?? catalogApiAuth.userId;
      if (!actor) throw new UnauthenticatedError();
      return actual.getAccessContext(actor, tenantId, actual.requestMeta(req, requestId));
    },
  };
});

async function invoke<P extends { tenantId: string }>(
  handler: (req: Request, ctx: { params: Promise<P> }) => Promise<Response>,
  req: Request,
  params: P,
): Promise<Response> {
  return handler(req, { params: Promise.resolve(params) });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function request(url: string, init: RequestInit & { json?: unknown } = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("x-request-id")) headers.set("x-request-id", uniqueSlug("rid"));
  const requestInit: RequestInit = { method: init.method ?? "GET", headers };
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    requestInit.body = JSON.stringify(init.json);
  }
  return new Request(url, requestInit);
}

function errorCode(body: Record<string, unknown>): string {
  return (body.error as { code: string }).code;
}

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

async function waitUntil(sql: string, label: string, minimum = 1): Promise<void> {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error("DATABASE_MIGRATION_URL is not set");
  const observer = new pg.Client({ connectionString: url });
  await observer.connect();
  try {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const result = await observer.query<{ n: string }>(sql);
      if (Number(result.rows[0]?.n ?? 0) >= minimum) return;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`timed out waiting for ${label}`);
  } finally {
    await observer.end();
  }
}

function waitUntilAdvisoryWaiters(minimum = 1): Promise<void> {
  return waitUntil(
    `SELECT count(*)::text AS n
     FROM pg_locks
     WHERE locktype = 'advisory' AND NOT granted`,
    `${minimum} blocked advisory lock(s)`,
    minimum,
  );
}

async function createScopedActor(
  tenantId: string,
  adminUserId: string,
  keys: string[],
  legalEntityIds: string[],
) {
  const user = await createTestUser();
  const mem = await addTenantMember(tenantId, user.id);
  const db = createSystemClient();
  const permissions =
    keys.length === 0
      ? []
      : await db.permission.findMany({ where: { key: { in: keys } } });
  expect(permissions).toHaveLength(keys.length);
  const role = await db.role.create({
    data: {
      tenantId,
      key: uniqueSlug("role"),
      name: uniqueSlug("Role"),
      isSystem: false,
      rolePermissions: {
        create: permissions.map((p) => ({ tenantId, permissionId: p.id })),
      },
    },
  });
  await assignRoleDirect(tenantId, mem.id, role.id, adminUserId, null);
  for (const legalEntityId of legalEntityIds) {
    await grantLegalEntityAccessDirect(tenantId, legalEntityId, user.id);
  }
  return user;
}

function toLinks(
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
) {
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

describe("P2D.3a catalog assignment/transfer concurrency", () => {
  let fixture: CatalogDomainFixture | undefined;
  const extraUsers: string[] = [];

  afterEach(async () => {
    catalogApiAuth.userId = undefined;
    for (const id of extraUsers.splice(0)) {
      await cleanupUser(id).catch(() => undefined);
    }
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("lets exactly one concurrent ownership transfer commit", async () => {
    fixture = await setupCatalogDomainFixture();
    const { setup, leA, leB, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    catalogApiAuth.userId = setup.adminUserId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const uom = await createTestUom(ctxAB);
    const created = await createCatalogItem(ctxAB, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Race transfer",
      baseUomId: uom.id,
    });
    const before = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        item: await tx.catalogItem.findFirstOrThrow({ where: { id: created.item.id } }),
        assignments: await tx.catalogItemLegalEntityAssignment.findMany({
          where: { catalogItemId: created.item.id },
          orderBy: { id: "asc" },
        }),
        transfers: await tx.auditEvent.count({
          where: { tenantId, action: AUDIT_ACTIONS.CATALOG_ITEM_OWNERSHIP_TRANSFERRED },
        }),
      }),
    );
    const makeTransfer = () =>
      invoke(
        itemTransfer,
        request(`${base}/catalog/items/${created.item.id}/ownership-transfer`, {
          method: "POST",
          json: { newOwnerLegalEntityId: leB.id, expectedVersion: created.item.version },
        }),
        { tenantId, catalogItemId: created.item.id },
      );
    const pendingFirst = makeTransfer();
    const firstAsserted = pendingFirst.then(async (res) => ({
      status: res.status,
      body: await readJson(res),
    }));
    const pendingSecond = makeTransfer();
    const secondAsserted = pendingSecond.then(async (res) => ({
      status: res.status,
      body: await readJson(res),
    }));
    const settled = await Promise.allSettled([firstAsserted, secondAsserted]);
    expect(settled.every((row) => row.status === "fulfilled")).toBe(true);
    const results = settled.map(
      (row) =>
        (row as PromiseFulfilledResult<{ status: number; body: Record<string, unknown> }>)
          .value,
    );
    expect(results.map((row) => row.status).sort()).toEqual([200, 409]);
    expect(errorCode(results.find((row) => row.status === 409)!.body)).toBe(
      "STALE_VERSION",
    );
    const after = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        item: await tx.catalogItem.findFirstOrThrow({ where: { id: created.item.id } }),
        assignments: await tx.catalogItemLegalEntityAssignment.findMany({
          where: { catalogItemId: created.item.id },
          orderBy: { id: "asc" },
        }),
        transfers: await tx.auditEvent.findMany({
          where: { tenantId, action: AUDIT_ACTIONS.CATALOG_ITEM_OWNERSHIP_TRANSFERRED },
        }),
        audits: await tx.auditEvent.findMany({
          where: { tenantId },
          orderBy: { sequence: "asc" },
        }),
      }),
    );
    expect(after.item.ownerLegalEntityId).toBe(leB.id);
    expect(after.item.version).toBe(before.item.version + 1);
    expect(after.assignments.map((row) => row.id)).toEqual(
      before.assignments.map((row) => row.id),
    );
    expect(after.assignments.map((row) => row.legalEntityId)).toEqual(
      before.assignments.map((row) => row.legalEntityId),
    );
    expect(after.transfers).toHaveLength(before.transfers + 1);
    expect(verifyAuditChain(toLinks(after.audits)).valid).toBe(true);
  }, 60_000);

  it("cannot leave zero ACTIVE assignments under concurrent archive", async () => {
    fixture = await setupCatalogDomainFixture();
    const { setup, leA, leB, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    catalogApiAuth.userId = setup.adminUserId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const uom = await createTestUom(ctxAB);
    const created = await createCatalogItem(ctxAB, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Race archive",
      baseUomId: uom.id,
    });
    const extra = await createCatalogItemAssignment(ctxAB, {
      catalogItemId: created.item.id,
      legalEntityId: leB.id,
    });
    const pendingFirst = invoke(
      assignmentArchive,
      request(`${base}/catalog/item-assignments/${created.assignment.id}/archive`, {
        method: "POST",
        json: { expectedVersion: created.assignment.version },
      }),
      { tenantId, assignmentId: created.assignment.id },
    );
    const firstAsserted = pendingFirst.then(async (res) => ({
      status: res.status,
      body: await readJson(res),
    }));
    const pendingSecond = invoke(
      assignmentArchive,
      request(`${base}/catalog/item-assignments/${extra.id}/archive`, {
        method: "POST",
        json: { expectedVersion: extra.version },
      }),
      { tenantId, assignmentId: extra.id },
    );
    const secondAsserted = pendingSecond.then(async (res) => ({
      status: res.status,
      body: await readJson(res),
    }));
    const settled = await Promise.allSettled([firstAsserted, secondAsserted]);
    expect(settled.every((row) => row.status === "fulfilled")).toBe(true);
    const results = settled.map(
      (row) =>
        (row as PromiseFulfilledResult<{ status: number; body: Record<string, unknown> }>)
          .value,
    );
    expect(results.map((row) => row.status).sort()).toEqual([200, 409]);
    expect(errorCode(results.find((row) => row.status === 409)!.body)).toBe("CONFLICT");
    const remaining = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) =>
        tx.catalogItemLegalEntityAssignment.count({
          where: { catalogItemId: created.item.id, status: "ACTIVE" },
        }),
    );
    expect(remaining).toBeGreaterThanOrEqual(1);
    const audits = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) =>
        tx.auditEvent.findMany({ where: { tenantId }, orderBy: { sequence: "asc" } }),
    );
    expect(verifyAuditChain(toLinks(audits)).valid).toBe(true);
  }, 60_000);

  it("serializes assignment create versus ownership transfer in both orderings", async () => {
    fixture = await setupCatalogDomainFixture();
    const { setup, leA, leB, leC, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    catalogApiAuth.userId = setup.adminUserId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const uom = await createTestUom(ctxAB);

    const first = await createCatalogItem(ctxAB, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Create then transfer",
      baseUomId: uom.id,
    });
    const pendingCreate = invoke(
      assignmentsPost,
      request(`${base}/catalog/item-assignments`, {
        method: "POST",
        json: { catalogItemId: first.item.id, legalEntityId: leC.id },
      }),
      { tenantId },
    );
    const createAsserted = pendingCreate.then(async (res) => ({
      status: res.status,
      body: await readJson(res),
    }));
    const pendingTransfer = invoke(
      itemTransfer,
      request(`${base}/catalog/items/${first.item.id}/ownership-transfer`, {
        method: "POST",
        json: { newOwnerLegalEntityId: leB.id, expectedVersion: first.item.version },
      }),
      { tenantId, catalogItemId: first.item.id },
    );
    const transferAsserted = pendingTransfer.then(async (res) => ({
      status: res.status,
      body: await readJson(res),
    }));
    const createFirst = await Promise.allSettled([createAsserted, transferAsserted]);
    expect(createFirst.every((row) => row.status === "fulfilled")).toBe(true);
    const createFirstResults = createFirst.map(
      (row) =>
        (row as PromiseFulfilledResult<{ status: number; body: Record<string, unknown> }>)
          .value,
    );
    expect(createFirstResults.map((row) => row.status).sort()).toEqual([200, 201]);
    const afterCreateFirst = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        item: await tx.catalogItem.findFirstOrThrow({ where: { id: first.item.id } }),
        assignments: await tx.catalogItemLegalEntityAssignment.findMany({
          where: { catalogItemId: first.item.id },
          orderBy: { legalEntityId: "asc" },
        }),
      }),
    );
    expect(afterCreateFirst.item.ownerLegalEntityId).toBe(leB.id);
    expect(afterCreateFirst.assignments.map((row) => row.legalEntityId).sort()).toEqual(
      [leA.id, leC.id].sort(),
    );

    const second = await createCatalogItem(ctxAB, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Transfer then create",
      baseUomId: uom.id,
    });
    const transferred = await invoke(
      itemTransfer,
      request(`${base}/catalog/items/${second.item.id}/ownership-transfer`, {
        method: "POST",
        json: { newOwnerLegalEntityId: leB.id, expectedVersion: second.item.version },
      }),
      { tenantId, catalogItemId: second.item.id },
    );
    expect(transferred.status).toBe(200);
    const createdAfter = await invoke(
      assignmentsPost,
      request(`${base}/catalog/item-assignments`, {
        method: "POST",
        json: { catalogItemId: second.item.id, legalEntityId: leC.id },
      }),
      { tenantId },
    );
    expect(createdAfter.status).toBe(201);
    const audits = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) =>
        tx.auditEvent.findMany({ where: { tenantId }, orderBy: { sequence: "asc" } }),
    );
    expect(verifyAuditChain(toLinks(audits)).valid).toBe(true);
  }, 90_000);

  it("returns NOT_FOUND when assignment-create resumes after HTTP ownership leaves B", async () => {
    fixture = await setupCatalogDomainFixture();
    const { setup, leA, leB, leC, leD, ctxAB, ctxA } = fixture;
    const tenantId = setup.tenantId;
    catalogApiAuth.userId = setup.adminUserId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const uom = await createTestUom(ctxA);
    const created = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "HTTP C-18 negative",
      baseUomId: uom.id,
    });
    const ownedByB = await transferCatalogItemOwnership(ctxAB, created.item.id, {
      newOwnerLegalEntityId: leB.id,
      expectedVersion: created.item.version,
    });
    expect(ownedByB.ownerLegalEntityId).toBe(leB.id);

    const actorBC = await createScopedActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_CREATE],
      [leB.id, leC.id],
    );
    extraUsers.push(actorBC.id);
    const actorBD = await createScopedActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.CATALOG_ITEM_TRANSFER_OWNERSHIP],
      [leB.id, leD.id],
    );
    extraUsers.push(actorBD.id);

    const db = createSystemClient();
    const before = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        item: await tx.catalogItem.findFirstOrThrow({ where: { id: created.item.id } }),
        assignments: await tx.catalogItemLegalEntityAssignment.findMany({
          where: { catalogItemId: created.item.id },
          orderBy: { id: "asc" },
        }),
        assignmentCreated: await tx.auditEvent.count({
          where: { tenantId, action: AUDIT_ACTIONS.CATALOG_ITEM_ASSIGNMENT_CREATED },
        }),
        transfers: await tx.auditEvent.count({
          where: {
            tenantId,
            entityId: created.item.id,
            action: AUDIT_ACTIONS.CATALOG_ITEM_OWNERSHIP_TRANSFERRED,
          },
        }),
      }),
    );
    expect(before.item.ownerLegalEntityId).toBe(leB.id);
    expect(before.assignments.map((row) => row.legalEntityId)).toEqual([leA.id]);

    let transferAsserted:
      Promise<{ status: number; body: Record<string, unknown> }> | undefined;
    let createAsserted:
      Promise<{ status: number; body: Record<string, unknown> }> | undefined;
    await holdTx(
      ctxAB,
      async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          advisoryKey(tenantId, created.item.id),
        ]);
      },
      async () => {
        const pendingTransfer = invoke(
          itemTransfer,
          request(`${base}/catalog/items/${created.item.id}/ownership-transfer`, {
            method: "POST",
            headers: { "x-test-actor": actorBD.id },
            json: {
              newOwnerLegalEntityId: leD.id,
              expectedVersion: ownedByB.version,
            },
          }),
          { tenantId, catalogItemId: created.item.id },
        );
        transferAsserted = pendingTransfer.then(async (res) => ({
          status: res.status,
          body: await readJson(res),
        }));
        await waitUntilAdvisoryWaiters(1);

        const pendingCreate = invoke(
          assignmentsPost,
          request(`${base}/catalog/item-assignments`, {
            method: "POST",
            headers: { "x-test-actor": actorBC.id },
            json: { catalogItemId: created.item.id, legalEntityId: leC.id },
          }),
          { tenantId },
        );
        createAsserted = pendingCreate.then(async (res) => ({
          status: res.status,
          body: await readJson(res),
        }));
        await waitUntilAdvisoryWaiters(2);

        expect(
          await db.catalogItem.findFirstOrThrow({ where: { id: created.item.id } }),
        ).toMatchObject({
          ownerLegalEntityId: leB.id,
          version: ownedByB.version,
        });
      },
    );

    const settled = await Promise.allSettled([transferAsserted!, createAsserted!]);
    expect(settled.every((row) => row.status === "fulfilled")).toBe(true);
    const transferResult = (
      settled[0] as PromiseFulfilledResult<{
        status: number;
        body: Record<string, unknown>;
      }>
    ).value;
    const createResult = (
      settled[1] as PromiseFulfilledResult<{
        status: number;
        body: Record<string, unknown>;
      }>
    ).value;
    expect(transferResult.status).toBe(200);
    expect(
      (transferResult.body.data as { item: { ownerLegalEntityId: string } }).item
        .ownerLegalEntityId,
    ).toBe(leD.id);
    expect(createResult.status).toBe(404);
    expect(errorCode(createResult.body)).toBe("NOT_FOUND");

    const after = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        item: await tx.catalogItem.findFirstOrThrow({ where: { id: created.item.id } }),
        assignments: await tx.catalogItemLegalEntityAssignment.findMany({
          where: { catalogItemId: created.item.id },
          orderBy: { id: "asc" },
        }),
        cRows: await tx.catalogItemLegalEntityAssignment.count({
          where: { catalogItemId: created.item.id, legalEntityId: leC.id },
        }),
        assignmentCreated: await tx.auditEvent.count({
          where: { tenantId, action: AUDIT_ACTIONS.CATALOG_ITEM_ASSIGNMENT_CREATED },
        }),
        transfers: await tx.auditEvent.findMany({
          where: {
            tenantId,
            entityId: created.item.id,
            action: AUDIT_ACTIONS.CATALOG_ITEM_OWNERSHIP_TRANSFERRED,
          },
        }),
        audits: await tx.auditEvent.findMany({
          where: { tenantId },
          orderBy: { sequence: "asc" },
        }),
      }),
    );
    expect(after.item.ownerLegalEntityId).toBe(leD.id);
    expect(after.item.version).toBe(ownedByB.version + 1);
    expect(after.cRows).toBe(0);
    expect(after.assignments.map((row) => row.id)).toEqual(
      before.assignments.map((row) => row.id),
    );
    expect(after.assignments.map((row) => row.legalEntityId)).toEqual(
      before.assignments.map((row) => row.legalEntityId),
    );
    expect(after.assignments.map((row) => row.status)).toEqual(
      before.assignments.map((row) => row.status),
    );
    expect(after.assignmentCreated).toBe(before.assignmentCreated);
    expect(after.transfers).toHaveLength(before.transfers + 1);
    expect(verifyAuditChain(toLinks(after.audits)).valid).toBe(true);
  }, 90_000);
});
