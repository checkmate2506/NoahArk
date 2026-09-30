import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { PERMISSIONS } from "@noahark/authz";
import { createSystemClient } from "@noahark/db/system";
import { withTenantContext } from "@noahark/db";
import { createPriceListAssignment } from "@/lib/services/catalogDomain";
import {
  GET as listsGet,
  POST as listsPost,
} from "@/app/api/v1/tenants/[tenantId]/pricing/price-lists/route";
import {
  GET as listGet,
  PATCH as listPatch,
} from "@/app/api/v1/tenants/[tenantId]/pricing/price-lists/[priceListId]/route";
import { POST as listTransfer } from "@/app/api/v1/tenants/[tenantId]/pricing/price-lists/[priceListId]/ownership-transfer/route";
import {
  GET as assignmentGet,
  PATCH as assignmentPatch,
} from "@/app/api/v1/tenants/[tenantId]/pricing/price-list-assignments/[assignmentId]/route";
import {
  addTenantMember,
  assignRoleDirect,
  cleanupTenant,
  cleanupUser,
  createTestLegalEntity,
  createTestUser,
  grantLegalEntityAccessDirect,
  setupTestTenant,
  uniqueSlug,
} from "./testHelpers";
import {
  catalogCode,
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
      if (!pricingApiAuth.userId) throw new UnauthenticatedError();
      return actual.getAccessContext(
        pricingApiAuth.userId,
        tenantId,
        actual.requestMeta(req, requestId),
      );
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

function opaqueShape(body: Record<string, unknown>) {
  const error = body.error as { code: string; message: string };
  return { code: error.code, hasMessage: typeof error.message === "string" };
}

async function createActor(
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

describe("P2D.3b pricing API isolation", () => {
  let fixture: PricingDomainFixture | undefined;
  const extraUsers: string[] = [];
  let other: Awaited<ReturnType<typeof setupTestTenant>> | undefined;

  afterEach(async () => {
    pricingApiAuth.userId = undefined;
    for (const id of extraUsers.splice(0)) {
      await cleanupUser(id).catch(() => undefined);
    }
    if (other) {
      await cleanupTenant(other.tenantId).catch(() => undefined);
      await cleanupUser(other.adminUserId).catch(() => undefined);
      other = undefined;
    }
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("hides invisible identifiers and forbids assigned non-owner mutations", async () => {
    fixture = await setupPricingDomainFixture();
    const { setup, ctxAB, leA, leB, leC } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    pricingApiAuth.userId = setup.adminUserId;
    const createdRes = await invoke(
      listsPost,
      request(`${base}/pricing/price-lists`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: catalogCode("PL"),
          name: "Isolation list",
          currency: "SGD",
        },
      }),
      { tenantId },
    );
    expect(createdRes.status).toBe(201);
    const created = (await readJson(createdRes)).data as {
      priceList: { id: string; version: number };
    };
    const extraAssign = await createPriceListAssignment(ctxAB, {
      priceListId: created.priceList.id,
      legalEntityId: leB.id,
    });

    const assigned = await createActor(
      tenantId,
      setup.adminUserId,
      [
        PERMISSIONS.PRICE_LIST_READ,
        PERMISSIONS.PRICE_LIST_UPDATE,
        PERMISSIONS.PRICE_LIST_TRANSFER_OWNERSHIP,
      ],
      [leB.id],
    );
    extraUsers.push(assigned.id);
    pricingApiAuth.userId = assigned.id;
    expect(
      (
        await invoke(
          listGet,
          request(`${base}/pricing/price-lists/${created.priceList.id}`),
          { tenantId, priceListId: created.priceList.id },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await invoke(
          listPatch,
          request(`${base}/pricing/price-lists/${created.priceList.id}`, {
            method: "PATCH",
            json: { expectedVersion: created.priceList.version, name: "Hijack" },
          }),
          { tenantId, priceListId: created.priceList.id },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invoke(
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
        )
      ).status,
    ).toBe(403);

    const unrelated = await createActor(
      tenantId,
      setup.adminUserId,
      [
        PERMISSIONS.PRICE_LIST_READ,
        PERMISSIONS.PRICE_LIST_UPDATE,
        PERMISSIONS.PRICE_LIST_ASSIGNMENT_READ,
        PERMISSIONS.PRICE_LIST_ASSIGNMENT_UPDATE,
      ],
      [leC.id],
    );
    extraUsers.push(unrelated.id);
    pricingApiAuth.userId = unrelated.id;
    const hidden = await invoke(
      listGet,
      request(`${base}/pricing/price-lists/${created.priceList.id}`),
      { tenantId, priceListId: created.priceList.id },
    );
    expect(hidden.status).toBe(404);
    const hiddenAssign = await invoke(
      assignmentGet,
      request(`${base}/pricing/price-list-assignments/${extraAssign.id}`),
      { tenantId, assignmentId: extraAssign.id },
    );
    expect(hiddenAssign.status).toBe(404);

    other = await setupTestTenant();
    const otherLe = await createTestLegalEntity(other.tenantId, "SG");
    await grantLegalEntityAccessDirect(other.tenantId, otherLe.id, other.adminUserId);
    pricingApiAuth.userId = other.adminUserId;
    const cross = await invoke(
      listGet,
      request(
        `https://noahark.example/api/v1/tenants/${other.tenantId}/pricing/price-lists/${created.priceList.id}`,
      ),
      { tenantId: other.tenantId, priceListId: created.priceList.id },
    );
    const missing = await invoke(
      listGet,
      request(
        `https://noahark.example/api/v1/tenants/${other.tenantId}/pricing/price-lists/does-not-exist`,
      ),
      { tenantId: other.tenantId, priceListId: "does-not-exist" },
    );
    expect(cross.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(opaqueShape(await readJson(cross))).toEqual(
      opaqueShape(await readJson(missing)),
    );

    pricingApiAuth.userId = setup.adminUserId;
    const forgedTenant = await invoke(
      listsGet,
      request(
        `https://noahark.example/api/v1/tenants/${other.tenantId}/pricing/price-lists`,
      ),
      { tenantId: other.tenantId },
    );
    expect(forgedTenant.status).toBe(403);

    const emptyScope = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.PRICE_LIST_READ],
      [],
    );
    extraUsers.push(emptyScope.id);
    pricingApiAuth.userId = emptyScope.id;
    expect(
      (await invoke(listsGet, request(`${base}/pricing/price-lists`), { tenantId }))
        .status,
    ).toBe(403);

    const widen = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.PRICE_LIST_CREATE],
      [leB.id],
    );
    extraUsers.push(widen.id);
    pricingApiAuth.userId = widen.id;
    const widenCreate = await invoke(
      listsPost,
      request(`${base}/pricing/price-lists`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: catalogCode("PL"),
          name: "Widen",
          currency: "SGD",
          legalEntityIds: [leA.id],
        },
      }),
      { tenantId },
    );
    expect(widenCreate.status).toBe(403);

    pricingApiAuth.userId = setup.adminUserId;
    const before = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        lists: await tx.priceList.count({ where: { tenantId } }),
        assignments: await tx.priceListLegalEntityAssignment.count({
          where: { tenantId },
        }),
        audits: await tx.auditEvent.count({ where: { tenantId } }),
        list: await tx.priceList.findFirstOrThrow({
          where: { id: created.priceList.id },
          select: { version: true, name: true, ownerLegalEntityId: true },
        }),
      }),
    );
    pricingApiAuth.userId = unrelated.id;
    const rejectedPatch = await invoke(
      listPatch,
      request(`${base}/pricing/price-lists/${created.priceList.id}`, {
        method: "PATCH",
        json: { expectedVersion: created.priceList.version, name: "Leak" },
      }),
      { tenantId, priceListId: created.priceList.id },
    );
    expect(rejectedPatch.status).toBe(404);
    const rejectedAssign = await invoke(
      assignmentPatch,
      request(`${base}/pricing/price-list-assignments/${extraAssign.id}`, {
        method: "PATCH",
        json: { expectedVersion: extraAssign.version, status: "SUSPENDED" },
      }),
      { tenantId, assignmentId: extraAssign.id },
    );
    expect(rejectedAssign.status).toBe(404);
    const leakText = JSON.stringify(await readJson(rejectedPatch));
    expect(leakText).not.toContain(leA.id);
    expect(leakText).not.toMatch(/23P01|P2002|prisma/i);
    expect(
      await withTenantContext(
        { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
        async (tx) => ({
          lists: await tx.priceList.count({ where: { tenantId } }),
          assignments: await tx.priceListLegalEntityAssignment.count({
            where: { tenantId },
          }),
          audits: await tx.auditEvent.count({ where: { tenantId } }),
          list: await tx.priceList.findFirstOrThrow({
            where: { id: created.priceList.id },
            select: { version: true, name: true, ownerLegalEntityId: true },
          }),
        }),
      ),
    ).toEqual(before);
  }, 120_000);
});
