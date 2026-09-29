import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { PERMISSIONS } from "@noahark/authz";
import { createSystemClient } from "@noahark/db/system";
import { withTenantContext } from "@noahark/db";
import { createCatalogItemAssignment } from "@/lib/services/catalogDomain";
import { GET as categoriesGet } from "@/app/api/v1/tenants/[tenantId]/catalog/categories/route";
import { GET as categoryGet } from "@/app/api/v1/tenants/[tenantId]/catalog/categories/[categoryId]/route";
import { GET as unitGet } from "@/app/api/v1/tenants/[tenantId]/catalog/units-of-measure/[unitId]/route";
import {
  GET as itemsGet,
  POST as itemsPost,
} from "@/app/api/v1/tenants/[tenantId]/catalog/items/route";
import {
  GET as itemGet,
  PATCH as itemPatch,
} from "@/app/api/v1/tenants/[tenantId]/catalog/items/[catalogItemId]/route";
import {
  GET as assignmentGet,
  PATCH as assignmentPatch,
} from "@/app/api/v1/tenants/[tenantId]/catalog/item-assignments/[assignmentId]/route";
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
  createTestCategory,
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
      if (!catalogApiAuth.userId) throw new UnauthenticatedError();
      return actual.getAccessContext(
        catalogApiAuth.userId,
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

function errorCode(body: Record<string, unknown>): string {
  return (body.error as { code: string }).code;
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

describe("P2D.3a catalog API isolation", () => {
  let fixture: CatalogDomainFixture | undefined;
  const extraUsers: string[] = [];
  let other: Awaited<ReturnType<typeof setupTestTenant>> | undefined;

  afterEach(async () => {
    catalogApiAuth.userId = undefined;
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

  it("keeps assigned-reader, 403-vs-404, forged tenant and empty-scope rules", async () => {
    fixture = await setupCatalogDomainFixture();
    const { setup, leA, leB, leC, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    catalogApiAuth.userId = setup.adminUserId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const category = await createTestCategory(ctxAB);
    const uom = await createTestUom(ctxAB);
    const createdRes = await invoke(
      itemsPost,
      request(`${base}/catalog/items`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: catalogCode("SKU"),
          itemType: "PRODUCT",
          name: "Isolation item",
          baseUomId: uom.id,
          categoryId: category.id,
        },
      }),
      { tenantId },
    );
    expect(createdRes.status).toBe(201);
    const item = (
      (await readJson(createdRes)).data as { item: { id: string; version: number } }
    ).item;
    const extraAssign = await createCatalogItemAssignment(ctxAB, {
      catalogItemId: item.id,
      legalEntityId: leB.id,
    });

    const assigned = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.CATALOG_ITEM_READ, PERMISSIONS.CATALOG_ITEM_UPDATE],
      [leB.id],
    );
    extraUsers.push(assigned.id);
    catalogApiAuth.userId = assigned.id;
    expect(
      (
        await invoke(itemGet, request(`${base}/catalog/items/${item.id}`), {
          tenantId,
          catalogItemId: item.id,
        })
      ).status,
    ).toBe(200);
    const assignedMutate = await invoke(
      itemPatch,
      request(`${base}/catalog/items/${item.id}`, {
        method: "PATCH",
        json: { expectedVersion: item.version, name: "Hijack" },
      }),
      { tenantId, catalogItemId: item.id },
    );
    expect(assignedMutate.status).toBe(403);
    expect(errorCode(await readJson(assignedMutate))).toBe("FORBIDDEN");

    const unrelated = await createActor(
      tenantId,
      setup.adminUserId,
      [
        PERMISSIONS.CATALOG_ITEM_READ,
        PERMISSIONS.CATALOG_ITEM_UPDATE,
        PERMISSIONS.CATALOG_CATEGORY_READ,
        PERMISSIONS.UNIT_OF_MEASURE_READ,
        PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_READ,
        PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_UPDATE,
      ],
      [leC.id],
    );
    extraUsers.push(unrelated.id);
    catalogApiAuth.userId = unrelated.id;
    const hiddenItem = await invoke(
      itemGet,
      request(`${base}/catalog/items/${item.id}`),
      {
        tenantId,
        catalogItemId: item.id,
      },
    );
    expect(hiddenItem.status).toBe(404);
    const hiddenAssign = await invoke(
      assignmentGet,
      request(`${base}/catalog/item-assignments/${extraAssign.id}`),
      { tenantId, assignmentId: extraAssign.id },
    );
    expect(hiddenAssign.status).toBe(404);

    other = await setupTestTenant();
    const otherLe = await createTestLegalEntity(other.tenantId, "SG");
    await grantLegalEntityAccessDirect(other.tenantId, otherLe.id, other.adminUserId);
    catalogApiAuth.userId = other.adminUserId;
    const crossItem = await invoke(
      itemGet,
      request(
        `https://noahark.example/api/v1/tenants/${other.tenantId}/catalog/items/${item.id}`,
      ),
      { tenantId: other.tenantId, catalogItemId: item.id },
    );
    const missingItem = await invoke(
      itemGet,
      request(
        `https://noahark.example/api/v1/tenants/${other.tenantId}/catalog/items/does-not-exist`,
      ),
      { tenantId: other.tenantId, catalogItemId: "does-not-exist" },
    );
    expect(crossItem.status).toBe(404);
    expect(missingItem.status).toBe(404);
    expect(opaqueShape(await readJson(crossItem))).toEqual(
      opaqueShape(await readJson(missingItem)),
    );
    const crossCat = await invoke(
      categoryGet,
      request(
        `https://noahark.example/api/v1/tenants/${other.tenantId}/catalog/categories/${category.id}`,
      ),
      { tenantId: other.tenantId, categoryId: category.id },
    );
    const missingCat = await invoke(
      categoryGet,
      request(
        `https://noahark.example/api/v1/tenants/${other.tenantId}/catalog/categories/does-not-exist`,
      ),
      { tenantId: other.tenantId, categoryId: "does-not-exist" },
    );
    expect(opaqueShape(await readJson(crossCat))).toEqual(
      opaqueShape(await readJson(missingCat)),
    );
    const crossUom = await invoke(
      unitGet,
      request(
        `https://noahark.example/api/v1/tenants/${other.tenantId}/catalog/units-of-measure/${uom.id}`,
      ),
      { tenantId: other.tenantId, unitId: uom.id },
    );
    const missingUom = await invoke(
      unitGet,
      request(
        `https://noahark.example/api/v1/tenants/${other.tenantId}/catalog/units-of-measure/does-not-exist`,
      ),
      { tenantId: other.tenantId, unitId: "does-not-exist" },
    );
    expect(opaqueShape(await readJson(crossUom))).toEqual(
      opaqueShape(await readJson(missingUom)),
    );

    catalogApiAuth.userId = setup.adminUserId;
    const forgedTenant = await invoke(
      itemsGet,
      request(`https://noahark.example/api/v1/tenants/${other.tenantId}/catalog/items`),
      { tenantId: other.tenantId },
    );
    expect(forgedTenant.status).toBe(403);

    const emptyScope = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.CATALOG_ITEM_READ, PERMISSIONS.CATALOG_CATEGORY_READ],
      [],
    );
    extraUsers.push(emptyScope.id);
    catalogApiAuth.userId = emptyScope.id;
    expect(
      (await invoke(itemsGet, request(`${base}/catalog/items`), { tenantId })).status,
    ).toBe(403);
    expect(
      (await invoke(categoriesGet, request(`${base}/catalog/categories`), { tenantId }))
        .status,
    ).toBe(403);

    catalogApiAuth.userId = assigned.id;
    const widenActor = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.CATALOG_ITEM_CREATE],
      [leB.id],
    );
    extraUsers.push(widenActor.id);
    catalogApiAuth.userId = widenActor.id;
    const widenCreate = await invoke(
      itemsPost,
      request(`${base}/catalog/items`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: catalogCode("SKU"),
          itemType: "PRODUCT",
          name: "Widen",
          baseUomId: uom.id,
          legalEntityIds: [leA.id],
        },
      }),
      { tenantId },
    );
    expect(widenCreate.status).toBe(403);

    catalogApiAuth.userId = setup.adminUserId;
    const before = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        items: await tx.catalogItem.count({ where: { tenantId } }),
        assignments: await tx.catalogItemLegalEntityAssignment.count({
          where: { tenantId },
        }),
        audits: await tx.auditEvent.count({ where: { tenantId } }),
        item: await tx.catalogItem.findFirstOrThrow({
          where: { id: item.id },
          select: { version: true, name: true, ownerLegalEntityId: true },
        }),
      }),
    );
    catalogApiAuth.userId = unrelated.id;
    const rejectedPatch = await invoke(
      itemPatch,
      request(`${base}/catalog/items/${item.id}`, {
        method: "PATCH",
        json: { expectedVersion: item.version, name: "Leak" },
      }),
      { tenantId, catalogItemId: item.id },
    );
    expect(rejectedPatch.status).toBe(404);
    const rejectedAssign = await invoke(
      assignmentPatch,
      request(`${base}/catalog/item-assignments/${extraAssign.id}`, {
        method: "PATCH",
        json: { expectedVersion: extraAssign.version, entityItemCode: "LEAK" },
      }),
      { tenantId, assignmentId: extraAssign.id },
    );
    expect(rejectedAssign.status).toBe(404);
    expect(JSON.stringify(await readJson(rejectedPatch))).not.toContain(leA.id);
    expect(
      await withTenantContext(
        { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
        async (tx) => ({
          items: await tx.catalogItem.count({ where: { tenantId } }),
          assignments: await tx.catalogItemLegalEntityAssignment.count({
            where: { tenantId },
          }),
          audits: await tx.auditEvent.count({ where: { tenantId } }),
          item: await tx.catalogItem.findFirstOrThrow({
            where: { id: item.id },
            select: { version: true, name: true, ownerLegalEntityId: true },
          }),
        }),
      ),
    ).toEqual(before);
  }, 120_000);
});
