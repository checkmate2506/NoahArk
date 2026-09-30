import { afterEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { UnauthenticatedError } from "@noahark/core";
import type { AccessContext } from "@noahark/core";
import { AUDIT_ACTIONS, verifyAuditChain } from "@noahark/audit";
import { PERMISSIONS } from "@noahark/authz";
import { withTenantContext } from "@noahark/db";
import { createSystemClient } from "@noahark/db/system";
import {
  createCatalogItemAssignment,
  createPriceListAssignment,
  transferPriceListOwnership,
} from "@/lib/services/catalogDomain";
import { POST as listTransfer } from "@/app/api/v1/tenants/[tenantId]/pricing/price-lists/[priceListId]/ownership-transfer/route";
import { POST as assignmentsPost } from "@/app/api/v1/tenants/[tenantId]/pricing/price-list-assignments/route";
import { POST as assignmentArchive } from "@/app/api/v1/tenants/[tenantId]/pricing/price-list-assignments/[assignmentId]/archive/route";
import { PATCH as assignmentPatch } from "@/app/api/v1/tenants/[tenantId]/pricing/price-list-assignments/[assignmentId]/route";
import { PATCH as catalogAssignmentPatch } from "@/app/api/v1/tenants/[tenantId]/catalog/item-assignments/[assignmentId]/route";
import { POST as entriesPost } from "@/app/api/v1/tenants/[tenantId]/pricing/price-list-entries/route";
import { PUT as setDefault } from "@/app/api/v1/tenants/[tenantId]/pricing/default-price-list/route";
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
  createTestItem,
  createTestPriceList,
  createTestUom,
  setupPricingDomainFixture,
  type PricingDomainFixture,
} from "./pricingDomainFixture";

const { pricingApiAuth } = vi.hoisted(() => ({
  pricingApiAuth: { userId: undefined as string | undefined },
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
      const actor = req.headers.get("x-test-actor") ?? pricingApiAuth.userId;
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

function assignmentKey(tenantId: string, priceListId: string): string {
  return `price-list-assignments:${tenantId}:${priceListId}`;
}

async function holdTx(
  ctx: AccessContext,
  acquire: (client: pg.Client) => Promise<void>,
  whileHeld: (holderPid: number) => Promise<void>,
  then: (client: pg.Client) => Promise<void> = async () => undefined,
): Promise<{ holderPid: number }> {
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
    const pid = Number(
      (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid,
    );
    await acquire(client);
    await whileHeld(pid);
    await then(client);
    await client.query("COMMIT");
    return { holderPid: pid };
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

function waitUntilAdvisoryWaiters(minimum = 1, holderPid?: number): Promise<void> {
  const pidFilter = holderPid == null ? "" : `AND pid <> ${holderPid}`;
  return waitUntil(
    `SELECT count(*)::text AS n
     FROM pg_locks
     WHERE locktype = 'advisory' AND NOT granted
     ${pidFilter}`,
    `${minimum} blocked advisory lock(s)`,
    minimum,
  );
}

function waitUntilRowLockWaiter(holderPid: number): Promise<void> {
  return waitUntil(
    `SELECT count(*)::text AS n
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND pid <> ${holderPid}
       AND wait_event_type = 'Lock'`,
    `a blocked row lock waiting on pid ${holderPid}`,
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

describe("P2D.3b pricing API concurrency", () => {
  let fixture: PricingDomainFixture | undefined;
  const extraUsers: string[] = [];

  afterEach(async () => {
    pricingApiAuth.userId = undefined;
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
    fixture = await setupPricingDomainFixture();
    const { setup, leA, leB, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    pricingApiAuth.userId = setup.adminUserId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const created = await createTestPriceList(ctxAB, leA.id);
    const before = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        list: await tx.priceList.findFirstOrThrow({
          where: { id: created.priceList.id },
        }),
        assignments: await tx.priceListLegalEntityAssignment.findMany({
          where: { priceListId: created.priceList.id },
          orderBy: { id: "asc" },
        }),
        transfers: await tx.auditEvent.count({
          where: { tenantId, action: AUDIT_ACTIONS.PRICE_LIST_OWNERSHIP_TRANSFERRED },
        }),
      }),
    );
    const makeTransfer = () =>
      invoke(
        listTransfer,
        request(
          `${base}/pricing/price-lists/${created.priceList.id}/ownership-transfer`,
          {
            method: "POST",
            json: {
              newOwnerLegalEntityId: leB.id,
              expectedVersion: created.priceList.version,
            },
          },
        ),
        { tenantId, priceListId: created.priceList.id },
      );
    const firstAsserted = makeTransfer().then(async (res) => ({
      status: res.status,
      body: await readJson(res),
    }));
    const secondAsserted = makeTransfer().then(async (res) => ({
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
        list: await tx.priceList.findFirstOrThrow({
          where: { id: created.priceList.id },
        }),
        assignments: await tx.priceListLegalEntityAssignment.findMany({
          where: { priceListId: created.priceList.id },
          orderBy: { id: "asc" },
        }),
        transfers: await tx.auditEvent.count({
          where: { tenantId, action: AUDIT_ACTIONS.PRICE_LIST_OWNERSHIP_TRANSFERRED },
        }),
        audits: await tx.auditEvent.findMany({
          where: { tenantId },
          orderBy: { sequence: "asc" },
        }),
      }),
    );
    expect(after.list.ownerLegalEntityId).toBe(leB.id);
    expect(after.list.version).toBe(before.list.version + 1);
    expect(after.assignments.map((row) => row.id)).toEqual(
      before.assignments.map((row) => row.id),
    );
    expect(after.transfers).toBe(before.transfers + 1);
    expect(verifyAuditChain(toLinks(after.audits)).valid).toBe(true);
  }, 90_000);

  it("lets exactly one concurrent last-ACTIVE archive/suspend succeed", async () => {
    fixture = await setupPricingDomainFixture();
    const { setup, ctxAB, leA, leB } = fixture;
    const tenantId = setup.tenantId;
    pricingApiAuth.userId = setup.adminUserId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const list = await createTestPriceList(ctxAB, leA.id);
    const extra = await createPriceListAssignment(ctxAB, {
      priceListId: list.priceList.id,
      legalEntityId: leB.id,
    });
    const archiveAsserted = invoke(
      assignmentArchive,
      request(`${base}/pricing/price-list-assignments/${list.assignment.id}/archive`, {
        method: "POST",
        json: { expectedVersion: list.assignment.version },
      }),
      { tenantId, assignmentId: list.assignment.id },
    ).then(async (res) => ({ status: res.status, body: await readJson(res) }));
    const suspendAsserted = invoke(
      assignmentPatch,
      request(`${base}/pricing/price-list-assignments/${extra.id}`, {
        method: "PATCH",
        json: { expectedVersion: extra.version, status: "SUSPENDED" },
      }),
      { tenantId, assignmentId: extra.id },
    ).then(async (res) => ({ status: res.status, body: await readJson(res) }));
    const settled = await Promise.allSettled([archiveAsserted, suspendAsserted]);
    expect(settled.every((row) => row.status === "fulfilled")).toBe(true);
    const results = settled.map(
      (row) =>
        (row as PromiseFulfilledResult<{ status: number; body: Record<string, unknown> }>)
          .value,
    );
    expect(results.filter((row) => row.status === 200)).toHaveLength(1);
    expect(results.filter((row) => row.status === 409)).toHaveLength(1);
    const after = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        active: await tx.priceListLegalEntityAssignment.count({
          where: { priceListId: list.priceList.id, status: "ACTIVE" },
        }),
        defaults: await tx.priceListLegalEntityAssignment.count({
          where: { priceListId: list.priceList.id, isDefault: true, status: "ACTIVE" },
        }),
        lifecycle: await tx.auditEvent.count({
          where: {
            tenantId,
            action: {
              in: [
                AUDIT_ACTIONS.PRICE_LIST_ASSIGNMENT_ARCHIVED,
                AUDIT_ACTIONS.PRICE_LIST_ASSIGNMENT_UPDATED,
              ],
            },
          },
        }),
        audits: await tx.auditEvent.findMany({
          where: { tenantId },
          orderBy: { sequence: "asc" },
        }),
      }),
    );
    expect(after.active).toBeGreaterThanOrEqual(1);
    expect(after.defaults).toBeLessThanOrEqual(1);
    expect(after.lifecycle).toBeGreaterThanOrEqual(1);
    expect(verifyAuditChain(toLinks(after.audits)).valid).toBe(true);
  }, 90_000);

  it("lets exactly one overlapping entry create commit", async () => {
    fixture = await setupPricingDomainFixture();
    const { setup, ctxAB, leA } = fixture;
    const tenantId = setup.tenantId;
    pricingApiAuth.userId = setup.adminUserId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const uom = await createTestUom(ctxAB);
    const item = await createTestItem(ctxAB, leA.id, uom.id);
    const list = await createTestPriceList(ctxAB, leA.id);
    const payload = {
      priceListAssignmentId: list.assignment.id,
      catalogItemAssignmentId: item.assignment.id,
      unitPrice: "1",
      effectiveFrom: "2026-07-01",
      effectiveTo: "2026-07-31",
    };
    const makeCreate = () =>
      invoke(
        entriesPost,
        request(`${base}/pricing/price-list-entries`, { method: "POST", json: payload }),
        { tenantId },
      ).then(async (res) => ({ status: res.status, body: await readJson(res) }));
    const settled = await Promise.allSettled([makeCreate(), makeCreate()]);
    expect(settled.every((row) => row.status === "fulfilled")).toBe(true);
    const results = settled.map(
      (row) =>
        (row as PromiseFulfilledResult<{ status: number; body: Record<string, unknown> }>)
          .value,
    );
    expect(results.map((row) => row.status).sort()).toEqual([201, 409]);
    const conflict = results.find((row) => row.status === 409)!;
    expect(errorCode(conflict.body)).toBe("CONFLICT");
    expect(JSON.stringify(conflict.body)).not.toMatch(/23P01|prisma|pg_|exclusion/i);
    const after = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        entries: await tx.priceListEntry.count({
          where: { priceListAssignmentId: list.assignment.id },
        }),
        created: await tx.auditEvent.count({
          where: { tenantId, action: AUDIT_ACTIONS.PRICE_LIST_ENTRY_CREATED },
        }),
        audits: await tx.auditEvent.findMany({
          where: { tenantId },
          orderBy: { sequence: "asc" },
        }),
      }),
    );
    expect(after.entries).toBe(1);
    expect(after.created).toBe(1);
    expect(verifyAuditChain(toLinks(after.audits)).valid).toBe(true);
  }, 90_000);

  it("keeps exactly one ACTIVE default after concurrent swaps", async () => {
    fixture = await setupPricingDomainFixture();
    const { setup, ctxAB, leA } = fixture;
    const tenantId = setup.tenantId;
    pricingApiAuth.userId = setup.adminUserId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const first = await createTestPriceList(ctxAB, leA.id, "SGD", "D1");
    const second = await createTestPriceList(ctxAB, leA.id, "SGD", "D2");
    const initial = await invoke(
      setDefault,
      request(`${base}/pricing/default-price-list`, {
        method: "PUT",
        json: { legalEntityId: leA.id, priceListId: first.priceList.id },
      }),
      { tenantId },
    );
    expect(initial.status).toBe(200);
    const swapA = invoke(
      setDefault,
      request(`${base}/pricing/default-price-list`, {
        method: "PUT",
        json: { legalEntityId: leA.id, priceListId: second.priceList.id },
      }),
      { tenantId },
    ).then(async (res) => ({ status: res.status, body: await readJson(res) }));
    const swapB = invoke(
      setDefault,
      request(`${base}/pricing/default-price-list`, {
        method: "PUT",
        json: { legalEntityId: leA.id, priceListId: first.priceList.id },
      }),
      { tenantId },
    ).then(async (res) => ({ status: res.status, body: await readJson(res) }));
    const settled = await Promise.allSettled([swapA, swapB]);
    expect(settled.every((row) => row.status === "fulfilled")).toBe(true);
    const after = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        defaults: await tx.priceListLegalEntityAssignment.findMany({
          where: { legalEntityId: leA.id, isDefault: true, status: "ACTIVE" },
        }),
        audits: await tx.auditEvent.findMany({
          where: { tenantId },
          orderBy: { sequence: "asc" },
        }),
      }),
    );
    expect(after.defaults).toHaveLength(1);
    expect(verifyAuditChain(toLinks(after.audits)).valid).toBe(true);
  }, 90_000);

  it("coordinates entry create versus price-list assignment suspension", async () => {
    fixture = await setupPricingDomainFixture();
    const { setup, ctxAB, leA, leB } = fixture;
    const tenantId = setup.tenantId;
    pricingApiAuth.userId = setup.adminUserId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const uom = await createTestUom(ctxAB);
    const item = await createTestItem(ctxAB, leA.id, uom.id);
    const list = await createTestPriceList(ctxAB, leA.id);
    await createPriceListAssignment(ctxAB, {
      priceListId: list.priceList.id,
      legalEntityId: leB.id,
    });
    let createAsserted: Promise<{ status: number }> | undefined;
    let suspendAsserted: Promise<{ status: number }> | undefined;
    const held = await holdTx(
      ctxAB,
      async (client) => {
        const locked = await client.query(
          `SELECT id FROM price_list_legal_entity_assignment
           WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
          [list.assignment.id, tenantId],
        );
        if (locked.rowCount !== 1) throw new Error("failed to share-lock PLA");
      },
      async (holderPid) => {
        createAsserted = invoke(
          entriesPost,
          request(`${base}/pricing/price-list-entries`, {
            method: "POST",
            json: {
              priceListAssignmentId: list.assignment.id,
              catalogItemAssignmentId: item.assignment.id,
              unitPrice: "1",
              effectiveFrom: "2026-09-01",
              effectiveTo: "2026-09-30",
            },
          }),
          { tenantId },
        ).then(async (res) => {
          expect(res.status).toBe(201);
          return { status: res.status };
        });
        suspendAsserted = invoke(
          assignmentPatch,
          request(`${base}/pricing/price-list-assignments/${list.assignment.id}`, {
            method: "PATCH",
            json: { expectedVersion: list.assignment.version, status: "SUSPENDED" },
          }),
          { tenantId, assignmentId: list.assignment.id },
        ).then(async (res) => {
          expect(res.status).toBe(200);
          return { status: res.status };
        });
        await waitUntilRowLockWaiter(holderPid);
        await createAsserted;
      },
    );
    await suspendAsserted;
    expect(held.holderPid).toBeGreaterThan(0);
    const list2 = await createTestPriceList(ctxAB, leA.id, "SGD", "SuspFirst");
    await createPriceListAssignment(ctxAB, {
      priceListId: list2.priceList.id,
      legalEntityId: leB.id,
    });
    const suspended = await invoke(
      assignmentPatch,
      request(`${base}/pricing/price-list-assignments/${list2.assignment.id}`, {
        method: "PATCH",
        json: { expectedVersion: list2.assignment.version, status: "SUSPENDED" },
      }),
      { tenantId, assignmentId: list2.assignment.id },
    );
    expect(suspended.status).toBe(200);
    const auditsBefore = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) =>
        tx.auditEvent.count({
          where: { tenantId, action: AUDIT_ACTIONS.PRICE_LIST_ENTRY_CREATED },
        }),
    );
    const rejected = await invoke(
      entriesPost,
      request(`${base}/pricing/price-list-entries`, {
        method: "POST",
        json: {
          priceListAssignmentId: list2.assignment.id,
          catalogItemAssignmentId: item.assignment.id,
          unitPrice: "1",
          effectiveFrom: "2026-10-01",
          effectiveTo: "2026-10-31",
        },
      }),
      { tenantId },
    );
    expect(rejected.status).toBe(409);
    expect(
      await withTenantContext(
        { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
        async (tx) => ({
          entries: await tx.priceListEntry.count({
            where: { priceListAssignmentId: list2.assignment.id },
          }),
          created: await tx.auditEvent.count({
            where: { tenantId, action: AUDIT_ACTIONS.PRICE_LIST_ENTRY_CREATED },
          }),
        }),
      ),
    ).toEqual({ entries: 0, created: auditsBefore });
  }, 90_000);

  it("coordinates entry create versus catalog-item assignment suspension", async () => {
    fixture = await setupPricingDomainFixture();
    const { setup, ctxAB, leA, leB } = fixture;
    const tenantId = setup.tenantId;
    pricingApiAuth.userId = setup.adminUserId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const uom = await createTestUom(ctxAB);
    const item = await createTestItem(ctxAB, leA.id, uom.id);
    await createCatalogItemAssignment(ctxAB, {
      catalogItemId: item.item.id,
      legalEntityId: leB.id,
    });
    const list = await createTestPriceList(ctxAB, leA.id);
    let createAsserted: Promise<{ status: number }> | undefined;
    let suspendAsserted: Promise<{ status: number }> | undefined;
    await holdTx(
      ctxAB,
      async (client) => {
        const locked = await client.query(
          `SELECT id FROM catalog_item_legal_entity_assignment
           WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
          [item.assignment.id, tenantId],
        );
        if (locked.rowCount !== 1) throw new Error("failed to share-lock CIA");
      },
      async (holderPid) => {
        createAsserted = invoke(
          entriesPost,
          request(`${base}/pricing/price-list-entries`, {
            method: "POST",
            json: {
              priceListAssignmentId: list.assignment.id,
              catalogItemAssignmentId: item.assignment.id,
              unitPrice: "1",
              effectiveFrom: "2026-09-01",
              effectiveTo: "2026-09-30",
            },
          }),
          { tenantId },
        ).then(async (res) => {
          expect(res.status).toBe(201);
          return { status: res.status };
        });
        suspendAsserted = invoke(
          catalogAssignmentPatch,
          request(`${base}/catalog/item-assignments/${item.assignment.id}`, {
            method: "PATCH",
            json: { expectedVersion: item.assignment.version, status: "SUSPENDED" },
          }),
          { tenantId, assignmentId: item.assignment.id },
        ).then(async (res) => {
          expect(res.status).toBe(200);
          return { status: res.status };
        });
        await waitUntilRowLockWaiter(holderPid);
        await createAsserted;
      },
    );
    await suspendAsserted;

    const item2 = await createTestItem(ctxAB, leA.id, uom.id, "Item2");
    await createCatalogItemAssignment(ctxAB, {
      catalogItemId: item2.item.id,
      legalEntityId: leB.id,
    });
    const suspended = await invoke(
      catalogAssignmentPatch,
      request(`${base}/catalog/item-assignments/${item2.assignment.id}`, {
        method: "PATCH",
        json: { expectedVersion: item2.assignment.version, status: "SUSPENDED" },
      }),
      { tenantId, assignmentId: item2.assignment.id },
    );
    expect(suspended.status).toBe(200);
    const rejected = await invoke(
      entriesPost,
      request(`${base}/pricing/price-list-entries`, {
        method: "POST",
        json: {
          priceListAssignmentId: list.assignment.id,
          catalogItemAssignmentId: item2.assignment.id,
          unitPrice: "1",
          effectiveFrom: "2026-10-01",
          effectiveTo: "2026-10-31",
        },
      }),
      { tenantId },
    );
    expect(rejected.status).toBe(409);
  }, 90_000);

  it("preserves assignment-create versus ownership-transfer ordering", async () => {
    fixture = await setupPricingDomainFixture();
    const { setup, ctxAB, leA, leB, leC, leD } = fixture;
    const tenantId = setup.tenantId;
    pricingApiAuth.userId = setup.adminUserId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const created = await createTestPriceList(ctxAB, leA.id);
    const ownedByB = await transferPriceListOwnership(ctxAB, created.priceList.id, {
      newOwnerLegalEntityId: leB.id,
      expectedVersion: created.priceList.version,
    });
    const actorBC = await createScopedActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.PRICE_LIST_ASSIGNMENT_CREATE],
      [leB.id, leC.id],
    );
    const actorBD = await createScopedActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.PRICE_LIST_TRANSFER_OWNERSHIP],
      [leB.id, leD.id],
    );
    extraUsers.push(actorBC.id, actorBD.id);

    let createDone: Promise<{ status: number }> | undefined;
    await holdTx(
      ctxAB,
      async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          assignmentKey(tenantId, created.priceList.id),
        ]);
      },
      async (holderPid) => {
        createDone = invoke(
          assignmentsPost,
          request(`${base}/pricing/price-list-assignments`, {
            method: "POST",
            headers: { "x-test-actor": actorBC.id },
            json: { priceListId: created.priceList.id, legalEntityId: leC.id },
          }),
          { tenantId },
        ).then(async (res) => {
          expect(res.status).toBe(201);
          return { status: res.status };
        });
        await waitUntilAdvisoryWaiters(1, holderPid);
      },
    );
    await createDone;

    const created2 = await createTestPriceList(ctxAB, leA.id, "SGD", "TOCTOU");
    const owned2 = await transferPriceListOwnership(ctxAB, created2.priceList.id, {
      newOwnerLegalEntityId: leB.id,
      expectedVersion: created2.priceList.version,
    });
    expect(owned2.ownerLegalEntityId).toBe(leB.id);
    const db = createSystemClient();
    const before = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        list: await tx.priceList.findFirstOrThrow({
          where: { id: created2.priceList.id },
        }),
        assignments: await tx.priceListLegalEntityAssignment.findMany({
          where: { priceListId: created2.priceList.id },
          orderBy: { id: "asc" },
        }),
        assignmentCreated: await tx.auditEvent.count({
          where: { tenantId, action: AUDIT_ACTIONS.PRICE_LIST_ASSIGNMENT_CREATED },
        }),
        transfers: await tx.auditEvent.count({
          where: {
            tenantId,
            entityId: created2.priceList.id,
            action: AUDIT_ACTIONS.PRICE_LIST_OWNERSHIP_TRANSFERRED,
          },
        }),
      }),
    );
    expect(before.list.ownerLegalEntityId).toBe(leB.id);
    expect(before.list.version).toBe(owned2.version);
    expect(before.assignments.map((row) => row.legalEntityId)).toEqual([leA.id]);

    let transferAsserted:
      Promise<{ status: number; body: Record<string, unknown> }> | undefined;
    let createAsserted:
      Promise<{ status: number; body: Record<string, unknown> }> | undefined;
    await holdTx(
      ctxAB,
      async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          assignmentKey(tenantId, created2.priceList.id),
        ]);
      },
      async (holderPid) => {
        const pendingTransfer = invoke(
          listTransfer,
          request(
            `${base}/pricing/price-lists/${created2.priceList.id}/ownership-transfer`,
            {
              method: "POST",
              headers: { "x-test-actor": actorBD.id },
              json: {
                newOwnerLegalEntityId: leD.id,
                expectedVersion: owned2.version,
              },
            },
          ),
          { tenantId, priceListId: created2.priceList.id },
        );
        transferAsserted = pendingTransfer.then(async (res) => ({
          status: res.status,
          body: await readJson(res),
        }));
        await waitUntilAdvisoryWaiters(1, holderPid);

        const pendingCreate = invoke(
          assignmentsPost,
          request(`${base}/pricing/price-list-assignments`, {
            method: "POST",
            headers: { "x-test-actor": actorBC.id },
            json: { priceListId: created2.priceList.id, legalEntityId: leC.id },
          }),
          { tenantId },
        );
        createAsserted = pendingCreate.then(async (res) => ({
          status: res.status,
          body: await readJson(res),
        }));
        await waitUntilAdvisoryWaiters(2, holderPid);

        const held = await db.priceList.findFirstOrThrow({
          where: { id: created2.priceList.id },
        });
        expect(held.ownerLegalEntityId).toBe(leB.id);
        expect(held.version).toBe(owned2.version);
        expect(
          await db.priceListLegalEntityAssignment.count({
            where: { priceListId: created2.priceList.id, legalEntityId: leC.id },
          }),
        ).toBe(0);
        expect(
          await db.auditEvent.count({
            where: { tenantId, action: AUDIT_ACTIONS.PRICE_LIST_ASSIGNMENT_CREATED },
          }),
        ).toBe(before.assignmentCreated);
        expect(
          await db.auditEvent.count({
            where: {
              tenantId,
              entityId: created2.priceList.id,
              action: AUDIT_ACTIONS.PRICE_LIST_OWNERSHIP_TRANSFERRED,
            },
          }),
        ).toBe(before.transfers);
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
      (transferResult.body.data as { priceList: { ownerLegalEntityId: string } })
        .priceList.ownerLegalEntityId,
    ).toBe(leD.id);
    expect(createResult.status).toBe(404);
    expect(errorCode(createResult.body)).toBe("NOT_FOUND");
    const after = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        list: await tx.priceList.findFirstOrThrow({
          where: { id: created2.priceList.id },
        }),
        assignments: await tx.priceListLegalEntityAssignment.findMany({
          where: { priceListId: created2.priceList.id },
          orderBy: { id: "asc" },
        }),
        cRows: await tx.priceListLegalEntityAssignment.count({
          where: { priceListId: created2.priceList.id, legalEntityId: leC.id },
        }),
        assignmentCreated: await tx.auditEvent.count({
          where: { tenantId, action: AUDIT_ACTIONS.PRICE_LIST_ASSIGNMENT_CREATED },
        }),
        transfers: await tx.auditEvent.findMany({
          where: {
            tenantId,
            entityId: created2.priceList.id,
            action: AUDIT_ACTIONS.PRICE_LIST_OWNERSHIP_TRANSFERRED,
          },
        }),
        audits: await tx.auditEvent.findMany({
          where: { tenantId },
          orderBy: { sequence: "asc" },
        }),
      }),
    );
    expect(after.list.ownerLegalEntityId).toBe(leD.id);
    expect(after.list.version).toBe(owned2.version + 1);
    expect(after.cRows).toBe(0);
    expect(after.assignments.map((row) => row.id)).toEqual(
      before.assignments.map((row) => row.id),
    );
    expect(after.assignments.map((row) => row.legalEntityId)).toEqual([leA.id]);
    expect(after.assignments.map((row) => row.status)).toEqual(
      before.assignments.map((row) => row.status),
    );
    expect(after.assignmentCreated).toBe(before.assignmentCreated);
    expect(after.transfers).toHaveLength(before.transfers + 1);
    expect(verifyAuditChain(toLinks(after.audits)).valid).toBe(true);
    expect(ownedByB.ownerLegalEntityId).toBe(leB.id);

    const created3 = await createTestPriceList(ctxAB, leA.id, "SGD", "Probe");
    const transferAuditsBefore = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) =>
        tx.auditEvent.count({
          where: {
            tenantId,
            entityId: created3.priceList.id,
            action: AUDIT_ACTIONS.PRICE_LIST_OWNERSHIP_TRANSFERRED,
          },
        }),
    );
    let transferDone: Promise<{ status: number }> | undefined;
    await holdTx(
      ctxAB,
      async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          assignmentKey(tenantId, created3.priceList.id),
        ]);
      },
      async (holderPid) => {
        transferDone = invoke(
          listTransfer,
          request(
            `${base}/pricing/price-lists/${created3.priceList.id}/ownership-transfer`,
            {
              method: "POST",
              json: {
                newOwnerLegalEntityId: leB.id,
                expectedVersion: created3.priceList.version,
              },
            },
          ),
          { tenantId, priceListId: created3.priceList.id },
        ).then(async (res) => {
          expect(res.status).toBe(200);
          return { status: res.status };
        });
        await waitUntilAdvisoryWaiters(1, holderPid);
        const stillOwned = await withTenantContext(
          { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
          (tx) => tx.priceList.findFirstOrThrow({ where: { id: created3.priceList.id } }),
        );
        expect(stillOwned.ownerLegalEntityId).toBe(leA.id);
        expect(
          await withTenantContext(
            { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
            (tx) =>
              tx.auditEvent.count({
                where: {
                  tenantId,
                  entityId: created3.priceList.id,
                  action: AUDIT_ACTIONS.PRICE_LIST_OWNERSHIP_TRANSFERRED,
                },
              }),
          ),
        ).toBe(transferAuditsBefore);
      },
    );
    await transferDone;
  }, 90_000);
});
