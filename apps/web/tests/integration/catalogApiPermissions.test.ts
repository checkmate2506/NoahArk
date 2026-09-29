import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { PERMISSIONS } from "@noahark/authz";
import { createSystemClient } from "@noahark/db/system";
import { withTenantContext } from "@noahark/db";
import {
  createCatalogItem,
  createCatalogItemAssignment,
} from "@/lib/services/catalogDomain";
import {
  API_WRITE_TENANT,
  API_WRITE_TENANT_USER,
  apiWriteCanonicalKey,
  hashKey,
} from "@/lib/rateLimiter";
import {
  GET as categoriesGet,
  POST as categoriesPost,
} from "@/app/api/v1/tenants/[tenantId]/catalog/categories/route";
import {
  GET as categoryGet,
  PATCH as categoryPatch,
} from "@/app/api/v1/tenants/[tenantId]/catalog/categories/[categoryId]/route";
import { POST as categoryDeactivate } from "@/app/api/v1/tenants/[tenantId]/catalog/categories/[categoryId]/deactivate/route";
import { POST as categoryActivate } from "@/app/api/v1/tenants/[tenantId]/catalog/categories/[categoryId]/activate/route";
import {
  GET as unitsGet,
  POST as unitsPost,
} from "@/app/api/v1/tenants/[tenantId]/catalog/units-of-measure/route";
import {
  GET as unitGet,
  PATCH as unitPatch,
} from "@/app/api/v1/tenants/[tenantId]/catalog/units-of-measure/[unitId]/route";
import { POST as unitDeactivate } from "@/app/api/v1/tenants/[tenantId]/catalog/units-of-measure/[unitId]/deactivate/route";
import { POST as unitActivate } from "@/app/api/v1/tenants/[tenantId]/catalog/units-of-measure/[unitId]/activate/route";
import {
  GET as itemsGet,
  POST as itemsPost,
} from "@/app/api/v1/tenants/[tenantId]/catalog/items/route";
import {
  GET as itemGet,
  PATCH as itemPatch,
} from "@/app/api/v1/tenants/[tenantId]/catalog/items/[catalogItemId]/route";
import { POST as itemTransfer } from "@/app/api/v1/tenants/[tenantId]/catalog/items/[catalogItemId]/ownership-transfer/route";
import {
  GET as assignmentsGet,
  POST as assignmentsPost,
} from "@/app/api/v1/tenants/[tenantId]/catalog/item-assignments/route";
import {
  GET as assignmentGet,
  PATCH as assignmentPatch,
} from "@/app/api/v1/tenants/[tenantId]/catalog/item-assignments/[assignmentId]/route";
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

type LooseHandler = (
  req: Request,
  ctx: { params: Promise<{ tenantId: string }> },
) => Promise<Response>;

async function invokeLoose(
  handler: LooseHandler,
  req: Request,
  params: { tenantId: string } & Record<string, string>,
): Promise<Response> {
  return handler(req, { params: Promise.resolve(params) });
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

async function createActor(
  tenantId: string,
  adminUserId: string,
  keys: string[],
  legalEntityIds: string[],
  roleLegalEntityId: string | null = null,
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
  await assignRoleDirect(tenantId, mem.id, role.id, adminUserId, roleLegalEntityId);
  for (const legalEntityId of legalEntityIds) {
    await grantLegalEntityAccessDirect(tenantId, legalEntityId, user.id);
  }
  return user;
}

async function writeBucketCounts(tenantId: string, userId: string) {
  const sys = createSystemClient();
  const userHash = hashKey(apiWriteCanonicalKey(API_WRITE_TENANT_USER, tenantId, userId));
  const tenantHash = hashKey(apiWriteCanonicalKey(API_WRITE_TENANT, tenantId));
  const [userRows, tenantRows] = await Promise.all([
    sys.authRateLimitBucket.findMany({
      where: { dimension: "EMAIL", keyHash: userHash },
    }),
    sys.authRateLimitBucket.findMany({
      where: { dimension: "IP", keyHash: tenantHash },
    }),
  ]);
  return {
    user: userRows.reduce((sum, row) => sum + row.attemptCount, 0),
    tenant: tenantRows.reduce((sum, row) => sum + row.attemptCount, 0),
  };
}

describe("P2D.3a catalog API permissions", () => {
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

  const matrix: Array<{
    name: string;
    permission: string;
    neighbor: string;
    success: number;
    write: boolean;
    run: (input: {
      base: string;
      tenantId: string;
      categoryId: string;
      categoryVersion: number;
      inactiveCategoryId: string;
      inactiveCategoryVersion: number;
      unitId: string;
      unitVersion: number;
      inactiveUnitId: string;
      inactiveUnitVersion: number;
      itemId: string;
      itemVersion: number;
      assignmentId: string;
      assignmentVersion: number;
      extraAssignmentId: string;
      extraAssignmentVersion: number;
      leA: string;
      leB: string;
      uomId: string;
    }) => {
      handler: LooseHandler;
      req: Request;
      params: { tenantId: string } & Record<string, string>;
    };
  }> = [
    {
      name: "GET /catalog/categories",
      permission: PERMISSIONS.CATALOG_CATEGORY_READ,
      neighbor: PERMISSIONS.CATALOG_CATEGORY_CREATE,
      success: 200,
      write: false,
      run: ({ base, tenantId }) => ({
        handler: categoriesGet as unknown as LooseHandler,
        req: request(`${base}/catalog/categories`),
        params: { tenantId },
      }),
    },
    {
      name: "POST /catalog/categories",
      permission: PERMISSIONS.CATALOG_CATEGORY_CREATE,
      neighbor: PERMISSIONS.CATALOG_CATEGORY_UPDATE,
      success: 201,
      write: true,
      run: ({ base, tenantId }) => ({
        handler: categoriesPost as unknown as LooseHandler,
        req: request(`${base}/catalog/categories`, {
          method: "POST",
          json: {
            code: catalogCode("CAT"),
            name: "Perm cat",
            permissions: [PERMISSIONS.CATALOG_CATEGORY_CREATE],
            actingUserId: "forged",
          },
        }),
        params: { tenantId },
      }),
    },
    {
      name: "GET /catalog/categories/{id}",
      permission: PERMISSIONS.CATALOG_CATEGORY_READ,
      neighbor: PERMISSIONS.CATALOG_CATEGORY_UPDATE,
      success: 200,
      write: false,
      run: ({ base, tenantId, categoryId }) => ({
        handler: categoryGet as unknown as LooseHandler,
        req: request(`${base}/catalog/categories/${categoryId}`),
        params: { tenantId, categoryId },
      }),
    },
    {
      name: "PATCH /catalog/categories/{id}",
      permission: PERMISSIONS.CATALOG_CATEGORY_UPDATE,
      neighbor: PERMISSIONS.CATALOG_CATEGORY_SET_STATUS,
      success: 200,
      write: true,
      run: ({ base, tenantId, categoryId, categoryVersion }) => ({
        handler: categoryPatch as unknown as LooseHandler,
        req: request(`${base}/catalog/categories/${categoryId}`, {
          method: "PATCH",
          json: { expectedVersion: categoryVersion, name: "Renamed" },
        }),
        params: { tenantId, categoryId },
      }),
    },
    {
      name: "POST /catalog/categories/{id}/deactivate",
      permission: PERMISSIONS.CATALOG_CATEGORY_SET_STATUS,
      neighbor: PERMISSIONS.CATALOG_CATEGORY_UPDATE,
      success: 200,
      write: true,
      run: ({ base, tenantId, categoryId, categoryVersion }) => ({
        handler: categoryDeactivate as unknown as LooseHandler,
        req: request(`${base}/catalog/categories/${categoryId}/deactivate`, {
          method: "POST",
          json: { expectedVersion: categoryVersion },
        }),
        params: { tenantId, categoryId },
      }),
    },
    {
      name: "POST /catalog/categories/{id}/activate",
      permission: PERMISSIONS.CATALOG_CATEGORY_SET_STATUS,
      neighbor: PERMISSIONS.CATALOG_CATEGORY_CREATE,
      success: 200,
      write: true,
      run: ({ base, tenantId, inactiveCategoryId, inactiveCategoryVersion }) => ({
        handler: categoryActivate as unknown as LooseHandler,
        req: request(`${base}/catalog/categories/${inactiveCategoryId}/activate`, {
          method: "POST",
          json: { expectedVersion: inactiveCategoryVersion },
        }),
        params: { tenantId, categoryId: inactiveCategoryId },
      }),
    },
    {
      name: "GET /catalog/units-of-measure",
      permission: PERMISSIONS.UNIT_OF_MEASURE_READ,
      neighbor: PERMISSIONS.UNIT_OF_MEASURE_CREATE,
      success: 200,
      write: false,
      run: ({ base, tenantId }) => ({
        handler: unitsGet as unknown as LooseHandler,
        req: request(`${base}/catalog/units-of-measure`),
        params: { tenantId },
      }),
    },
    {
      name: "POST /catalog/units-of-measure",
      permission: PERMISSIONS.UNIT_OF_MEASURE_CREATE,
      neighbor: PERMISSIONS.UNIT_OF_MEASURE_UPDATE,
      success: 201,
      write: true,
      run: ({ base, tenantId }) => ({
        handler: unitsPost as unknown as LooseHandler,
        req: request(`${base}/catalog/units-of-measure`, {
          method: "POST",
          json: { code: catalogCode("UOM"), name: "Perm uom" },
        }),
        params: { tenantId },
      }),
    },
    {
      name: "GET /catalog/units-of-measure/{id}",
      permission: PERMISSIONS.UNIT_OF_MEASURE_READ,
      neighbor: PERMISSIONS.UNIT_OF_MEASURE_UPDATE,
      success: 200,
      write: false,
      run: ({ base, tenantId, unitId }) => ({
        handler: unitGet as unknown as LooseHandler,
        req: request(`${base}/catalog/units-of-measure/${unitId}`),
        params: { tenantId, unitId },
      }),
    },
    {
      name: "PATCH /catalog/units-of-measure/{id}",
      permission: PERMISSIONS.UNIT_OF_MEASURE_UPDATE,
      neighbor: PERMISSIONS.UNIT_OF_MEASURE_SET_STATUS,
      success: 200,
      write: true,
      run: ({ base, tenantId, unitId, unitVersion }) => ({
        handler: unitPatch as unknown as LooseHandler,
        req: request(`${base}/catalog/units-of-measure/${unitId}`, {
          method: "PATCH",
          json: { expectedVersion: unitVersion, name: "Renamed uom" },
        }),
        params: { tenantId, unitId },
      }),
    },
    {
      name: "POST /catalog/units-of-measure/{id}/deactivate",
      permission: PERMISSIONS.UNIT_OF_MEASURE_SET_STATUS,
      neighbor: PERMISSIONS.UNIT_OF_MEASURE_UPDATE,
      success: 200,
      write: true,
      run: ({ base, tenantId, unitId, unitVersion }) => ({
        handler: unitDeactivate as unknown as LooseHandler,
        req: request(`${base}/catalog/units-of-measure/${unitId}/deactivate`, {
          method: "POST",
          json: { expectedVersion: unitVersion },
        }),
        params: { tenantId, unitId },
      }),
    },
    {
      name: "POST /catalog/units-of-measure/{id}/activate",
      permission: PERMISSIONS.UNIT_OF_MEASURE_SET_STATUS,
      neighbor: PERMISSIONS.UNIT_OF_MEASURE_CREATE,
      success: 200,
      write: true,
      run: ({ base, tenantId, inactiveUnitId, inactiveUnitVersion }) => ({
        handler: unitActivate as unknown as LooseHandler,
        req: request(`${base}/catalog/units-of-measure/${inactiveUnitId}/activate`, {
          method: "POST",
          json: { expectedVersion: inactiveUnitVersion },
        }),
        params: { tenantId, unitId: inactiveUnitId },
      }),
    },
    {
      name: "GET /catalog/items",
      permission: PERMISSIONS.CATALOG_ITEM_READ,
      neighbor: PERMISSIONS.CATALOG_ITEM_CREATE,
      success: 200,
      write: false,
      run: ({ base, tenantId }) => ({
        handler: itemsGet as unknown as LooseHandler,
        req: request(`${base}/catalog/items`),
        params: { tenantId },
      }),
    },
    {
      name: "POST /catalog/items",
      permission: PERMISSIONS.CATALOG_ITEM_CREATE,
      neighbor: PERMISSIONS.CATALOG_ITEM_UPDATE,
      success: 201,
      write: true,
      run: ({ base, tenantId, leA, uomId }) => ({
        handler: itemsPost as unknown as LooseHandler,
        req: request(`${base}/catalog/items`, {
          method: "POST",
          json: {
            ownerLegalEntityId: leA,
            code: catalogCode("SKU"),
            itemType: "PRODUCT",
            name: "Perm item",
            baseUomId: uomId,
            permissions: [PERMISSIONS.CATALOG_ITEM_CREATE],
          },
        }),
        params: { tenantId },
      }),
    },
    {
      name: "GET /catalog/items/{id}",
      permission: PERMISSIONS.CATALOG_ITEM_READ,
      neighbor: PERMISSIONS.CATALOG_ITEM_UPDATE,
      success: 200,
      write: false,
      run: ({ base, tenantId, itemId }) => ({
        handler: itemGet as unknown as LooseHandler,
        req: request(`${base}/catalog/items/${itemId}`),
        params: { tenantId, catalogItemId: itemId },
      }),
    },
    {
      name: "PATCH /catalog/items/{id}",
      permission: PERMISSIONS.CATALOG_ITEM_UPDATE,
      neighbor: PERMISSIONS.CATALOG_ITEM_TRANSFER_OWNERSHIP,
      success: 200,
      write: true,
      run: ({ base, tenantId, itemId, itemVersion }) => ({
        handler: itemPatch as unknown as LooseHandler,
        req: request(`${base}/catalog/items/${itemId}`, {
          method: "PATCH",
          json: { expectedVersion: itemVersion, name: "Perm updated" },
        }),
        params: { tenantId, catalogItemId: itemId },
      }),
    },
    {
      name: "POST /catalog/items/{id}/ownership-transfer",
      permission: PERMISSIONS.CATALOG_ITEM_TRANSFER_OWNERSHIP,
      neighbor: PERMISSIONS.CATALOG_ITEM_UPDATE,
      success: 200,
      write: true,
      run: ({ base, tenantId, itemId, itemVersion, leB }) => ({
        handler: itemTransfer as unknown as LooseHandler,
        req: request(`${base}/catalog/items/${itemId}/ownership-transfer`, {
          method: "POST",
          json: { newOwnerLegalEntityId: leB, expectedVersion: itemVersion },
        }),
        params: { tenantId, catalogItemId: itemId },
      }),
    },
    {
      name: "GET /catalog/item-assignments",
      permission: PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_READ,
      neighbor: PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_CREATE,
      success: 200,
      write: false,
      run: ({ base, tenantId }) => ({
        handler: assignmentsGet as unknown as LooseHandler,
        req: request(`${base}/catalog/item-assignments`),
        params: { tenantId },
      }),
    },
    {
      name: "POST /catalog/item-assignments",
      permission: PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_CREATE,
      neighbor: PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_UPDATE,
      success: 201,
      write: true,
      run: ({ base, tenantId, itemId, leB }) => ({
        handler: assignmentsPost as unknown as LooseHandler,
        req: request(`${base}/catalog/item-assignments`, {
          method: "POST",
          json: { catalogItemId: itemId, legalEntityId: leB },
        }),
        params: { tenantId },
      }),
    },
    {
      name: "GET /catalog/item-assignments/{id}",
      permission: PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_READ,
      neighbor: PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_UPDATE,
      success: 200,
      write: false,
      run: ({ base, tenantId, assignmentId }) => ({
        handler: assignmentGet as unknown as LooseHandler,
        req: request(`${base}/catalog/item-assignments/${assignmentId}`),
        params: { tenantId, assignmentId },
      }),
    },
    {
      name: "PATCH /catalog/item-assignments/{id}",
      permission: PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_UPDATE,
      neighbor: PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_ARCHIVE,
      success: 200,
      write: true,
      run: ({ base, tenantId, extraAssignmentId, extraAssignmentVersion }) => ({
        handler: assignmentPatch as unknown as LooseHandler,
        req: request(`${base}/catalog/item-assignments/${extraAssignmentId}`, {
          method: "PATCH",
          json: { expectedVersion: extraAssignmentVersion, entityItemCode: "P-1" },
        }),
        params: { tenantId, assignmentId: extraAssignmentId },
      }),
    },
    {
      name: "POST /catalog/item-assignments/{id}/archive",
      permission: PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_ARCHIVE,
      neighbor: PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_UPDATE,
      success: 200,
      write: true,
      run: ({ base, tenantId, extraAssignmentId, extraAssignmentVersion }) => ({
        handler: assignmentArchive as unknown as LooseHandler,
        req: request(`${base}/catalog/item-assignments/${extraAssignmentId}/archive`, {
          method: "POST",
          json: { expectedVersion: extraAssignmentVersion },
        }),
        params: { tenantId, assignmentId: extraAssignmentId },
      }),
    },
  ];

  it("allows the exact permission for all 22 operations", async () => {
    fixture = await setupCatalogDomainFixture();
    const { setup, leA, leB, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    for (const op of matrix) {
      catalogApiAuth.userId = setup.adminUserId;
      const category = await createTestCategory(ctxAB);
      const inactiveCategory = await createTestCategory(ctxAB, "Off");
      const deactivatedCat = await invokeLoose(
        categoryDeactivate as unknown as LooseHandler,
        request(`${base}/catalog/categories/${inactiveCategory.id}/deactivate`, {
          method: "POST",
          json: { expectedVersion: inactiveCategory.version },
        }),
        { tenantId, categoryId: inactiveCategory.id },
      );
      expect(deactivatedCat.status).toBe(200);
      const unit = await createTestUom(ctxAB);
      const inactiveUnit = await createTestUom(ctxAB, "Off uom");
      catalogApiAuth.userId = setup.adminUserId;
      const deactivatedUnit = await invokeLoose(
        unitDeactivate as unknown as LooseHandler,
        request(`${base}/catalog/units-of-measure/${inactiveUnit.id}/deactivate`, {
          method: "POST",
          json: { expectedVersion: inactiveUnit.version },
        }),
        { tenantId, unitId: inactiveUnit.id },
      );
      expect(deactivatedUnit.status).toBe(200);
      const item = await createCatalogItem(ctxAB, {
        ownerLegalEntityId: leA.id,
        code: catalogCode("SKU"),
        itemType: "PRODUCT",
        name: `Perm ${op.name}`,
        baseUomId: unit.id,
      });
      const extra =
        op.name === "POST /catalog/item-assignments"
          ? item.assignment
          : await createCatalogItemAssignment(ctxAB, {
              catalogItemId: item.item.id,
              legalEntityId: leB.id,
            });
      const actor = await createActor(
        tenantId,
        setup.adminUserId,
        [op.permission],
        [leA.id, leB.id],
      );
      extraUsers.push(actor.id);
      catalogApiAuth.userId = actor.id;
      const call = op.run({
        base,
        tenantId,
        categoryId: category.id,
        categoryVersion: category.version,
        inactiveCategoryId: inactiveCategory.id,
        inactiveCategoryVersion: 2,
        unitId: unit.id,
        unitVersion: unit.version,
        inactiveUnitId: inactiveUnit.id,
        inactiveUnitVersion: 2,
        itemId: item.item.id,
        itemVersion: item.item.version,
        assignmentId: item.assignment.id,
        assignmentVersion: item.assignment.version,
        extraAssignmentId: extra.id,
        extraAssignmentVersion: extra.version,
        leA: leA.id,
        leB: leB.id,
        uomId: unit.id,
      });
      expect(
        (await invokeLoose(call.handler, call.req, call.params)).status,
        op.name,
      ).toBe(op.success);
    }
  }, 180_000);

  it("rejects a missing key, a neighbouring key, and forged body authority", async () => {
    fixture = await setupCatalogDomainFixture();
    const { setup, leA, leB, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const category = await createTestCategory(ctxAB);
    const inactiveCategory = await createTestCategory(ctxAB, "Off");
    catalogApiAuth.userId = setup.adminUserId;
    expect(
      (
        await invokeLoose(
          categoryDeactivate as unknown as LooseHandler,
          request(`${base}/catalog/categories/${inactiveCategory.id}/deactivate`, {
            method: "POST",
            json: { expectedVersion: inactiveCategory.version },
          }),
          { tenantId, categoryId: inactiveCategory.id },
        )
      ).status,
    ).toBe(200);
    const unit = await createTestUom(ctxAB);
    const inactiveUnit = await createTestUom(ctxAB, "Off uom");
    expect(
      (
        await invokeLoose(
          unitDeactivate as unknown as LooseHandler,
          request(`${base}/catalog/units-of-measure/${inactiveUnit.id}/deactivate`, {
            method: "POST",
            json: { expectedVersion: inactiveUnit.version },
          }),
          { tenantId, unitId: inactiveUnit.id },
        )
      ).status,
    ).toBe(200);
    const item = await createCatalogItem(ctxAB, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Denied item",
      baseUomId: unit.id,
    });
    const extra = await createCatalogItemAssignment(ctxAB, {
      catalogItemId: item.item.id,
      legalEntityId: leB.id,
    });
    const snapshot = () =>
      withTenantContext(
        { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
        async (tx) => ({
          categories: await tx.catalogCategory.count({ where: { tenantId } }),
          units: await tx.unitOfMeasure.count({ where: { tenantId } }),
          items: await tx.catalogItem.count({ where: { tenantId } }),
          assignments: await tx.catalogItemLegalEntityAssignment.count({
            where: { tenantId },
          }),
          audits: await tx.auditEvent.count({ where: { tenantId } }),
        }),
      );
    for (const op of matrix) {
      const none = await createActor(tenantId, setup.adminUserId, [], [leA.id, leB.id]);
      extraUsers.push(none.id);
      const neighbor = await createActor(
        tenantId,
        setup.adminUserId,
        [op.neighbor],
        [leA.id, leB.id],
      );
      extraUsers.push(neighbor.id);
      const call = op.run({
        base,
        tenantId,
        categoryId: category.id,
        categoryVersion: category.version,
        inactiveCategoryId: inactiveCategory.id,
        inactiveCategoryVersion: 2,
        unitId: unit.id,
        unitVersion: unit.version,
        inactiveUnitId: inactiveUnit.id,
        inactiveUnitVersion: 2,
        itemId: item.item.id,
        itemVersion: item.item.version,
        assignmentId: item.assignment.id,
        assignmentVersion: item.assignment.version,
        extraAssignmentId: extra.id,
        extraAssignmentVersion: extra.version,
        leA: leA.id,
        leB: leB.id,
        uomId: unit.id,
      });
      const before = await snapshot();
      const beforeBuckets = await writeBucketCounts(tenantId, none.id);
      catalogApiAuth.userId = none.id;
      expect(
        (await invokeLoose(call.handler, call.req.clone(), call.params)).status,
        `${op.name} absent`,
      ).toBe(403);
      catalogApiAuth.userId = neighbor.id;
      expect(
        (await invokeLoose(call.handler, call.req.clone(), call.params)).status,
        `${op.name} neighbor`,
      ).toBe(403);
      expect(await snapshot(), `${op.name} snapshot`).toEqual(before);
      if (op.write) {
        expect(await writeBucketCounts(tenantId, none.id)).toEqual(beforeBuckets);
      }
    }
  }, 180_000);

  it("keeps entity-scoped item-create and assignment-create on the matching body legal entity", async () => {
    fixture = await setupCatalogDomainFixture();
    const { setup, leA, leB, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const uom = await createTestUom(ctxAB);
    const itemActor = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.CATALOG_ITEM_CREATE],
      [leA.id, leB.id],
      leB.id,
    );
    extraUsers.push(itemActor.id);
    catalogApiAuth.userId = itemActor.id;
    const okItem = await invokeLoose(
      itemsPost as unknown as LooseHandler,
      request(`${base}/catalog/items`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leB.id,
          code: catalogCode("SKU"),
          itemType: "PRODUCT",
          name: "Scoped item",
          baseUomId: uom.id,
        },
      }),
      { tenantId },
    );
    expect(okItem.status).toBe(201);
    const deniedItem = await invokeLoose(
      itemsPost as unknown as LooseHandler,
      request(`${base}/catalog/items`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: catalogCode("SKU"),
          itemType: "PRODUCT",
          name: "Wrong LE",
          baseUomId: uom.id,
          permissions: [PERMISSIONS.CATALOG_ITEM_CREATE],
        },
      }),
      { tenantId },
    );
    expect(deniedItem.status).toBe(403);

    const seeded = await createCatalogItem(ctxAB, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Assign seed",
      baseUomId: uom.id,
    });
    const assignActor = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_CREATE],
      [leA.id, leB.id],
      leB.id,
    );
    extraUsers.push(assignActor.id);
    catalogApiAuth.userId = assignActor.id;
    const okAssign = await invokeLoose(
      assignmentsPost as unknown as LooseHandler,
      request(`${base}/catalog/item-assignments`, {
        method: "POST",
        json: { catalogItemId: seeded.item.id, legalEntityId: leB.id },
      }),
      { tenantId },
    );
    expect(okAssign.status).toBe(201);
    const deniedAssign = await invokeLoose(
      assignmentsPost as unknown as LooseHandler,
      request(`${base}/catalog/item-assignments`, {
        method: "POST",
        json: {
          catalogItemId: seeded.item.id,
          legalEntityId: leA.id,
          permissions: [PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_CREATE],
        },
      }),
      { tenantId },
    );
    expect(deniedAssign.status).toBe(403);
  }, 90_000);

  it("requires tenant-wide permission for unfiltered assignment list, id-derived ops, item update/transfer and all category/UOM ops", async () => {
    fixture = await setupCatalogDomainFixture();
    const { setup, leA, leB, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const category = await createTestCategory(ctxAB);
    const unit = await createTestUom(ctxAB);
    const item = await createCatalogItem(ctxAB, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Tenant-wide item",
      baseUomId: unit.id,
    });
    const extra = await createCatalogItemAssignment(ctxAB, {
      catalogItemId: item.item.id,
      legalEntityId: leB.id,
    });
    const scoped = await createActor(
      tenantId,
      setup.adminUserId,
      [
        PERMISSIONS.CATALOG_CATEGORY_READ,
        PERMISSIONS.CATALOG_CATEGORY_CREATE,
        PERMISSIONS.UNIT_OF_MEASURE_READ,
        PERMISSIONS.UNIT_OF_MEASURE_CREATE,
        PERMISSIONS.CATALOG_ITEM_READ,
        PERMISSIONS.CATALOG_ITEM_UPDATE,
        PERMISSIONS.CATALOG_ITEM_TRANSFER_OWNERSHIP,
        PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_READ,
        PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_UPDATE,
        PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_ARCHIVE,
      ],
      [leA.id, leB.id],
      leB.id,
    );
    extraUsers.push(scoped.id);
    catalogApiAuth.userId = scoped.id;
    expect(
      (
        await invokeLoose(
          categoriesGet as unknown as LooseHandler,
          request(`${base}/catalog/categories`),
          { tenantId },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          unitsGet as unknown as LooseHandler,
          request(`${base}/catalog/units-of-measure`),
          { tenantId },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          itemPatch as unknown as LooseHandler,
          request(`${base}/catalog/items/${item.item.id}`, {
            method: "PATCH",
            json: { expectedVersion: item.item.version, name: "No" },
          }),
          { tenantId, catalogItemId: item.item.id },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          itemsGet as unknown as LooseHandler,
          request(`${base}/catalog/items`),
          { tenantId },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          itemGet as unknown as LooseHandler,
          request(`${base}/catalog/items/${item.item.id}`),
          { tenantId, catalogItemId: item.item.id },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          itemTransfer as unknown as LooseHandler,
          request(`${base}/catalog/items/${item.item.id}/ownership-transfer`, {
            method: "POST",
            json: { newOwnerLegalEntityId: leB.id, expectedVersion: item.item.version },
          }),
          { tenantId, catalogItemId: item.item.id },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          assignmentsGet as unknown as LooseHandler,
          request(`${base}/catalog/item-assignments`),
          { tenantId },
        )
      ).status,
    ).toBe(403);
    const filtered = await invokeLoose(
      assignmentsGet as unknown as LooseHandler,
      request(`${base}/catalog/item-assignments?legalEntityId=${leB.id}`),
      { tenantId },
    );
    expect(filtered.status).toBe(200);
    const otherFilter = await invokeLoose(
      assignmentsGet as unknown as LooseHandler,
      request(`${base}/catalog/item-assignments?legalEntityId=${leA.id}`),
      { tenantId },
    );
    expect(otherFilter.status).toBe(403);
    expect(
      (
        await invokeLoose(
          assignmentGet as unknown as LooseHandler,
          request(`${base}/catalog/item-assignments/${extra.id}`),
          { tenantId, assignmentId: extra.id },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          assignmentPatch as unknown as LooseHandler,
          request(`${base}/catalog/item-assignments/${extra.id}`, {
            method: "PATCH",
            json: { expectedVersion: extra.version, entityItemCode: "X" },
          }),
          { tenantId, assignmentId: extra.id },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          assignmentArchive as unknown as LooseHandler,
          request(`${base}/catalog/item-assignments/${extra.id}/archive`, {
            method: "POST",
            json: { expectedVersion: extra.version },
          }),
          { tenantId, assignmentId: extra.id },
        )
      ).status,
    ).toBe(403);
    expect(category.id).toBeTruthy();
  }, 90_000);
});
