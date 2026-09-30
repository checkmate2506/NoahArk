import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { PERMISSIONS } from "@noahark/authz";
import { createSystemClient } from "@noahark/db/system";
import { withTenantContext } from "@noahark/db";
import {
  createCatalogItemAssignment,
  createPriceListAssignment,
  createPriceListEntry,
} from "@/lib/services/catalogDomain";
import {
  API_WRITE_TENANT,
  API_WRITE_TENANT_USER,
  apiWriteCanonicalKey,
  hashKey,
} from "@/lib/rateLimiter";
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
  GET as assignmentsGet,
  POST as assignmentsPost,
} from "@/app/api/v1/tenants/[tenantId]/pricing/price-list-assignments/route";
import {
  GET as assignmentGet,
  PATCH as assignmentPatch,
} from "@/app/api/v1/tenants/[tenantId]/pricing/price-list-assignments/[assignmentId]/route";
import { POST as assignmentArchive } from "@/app/api/v1/tenants/[tenantId]/pricing/price-list-assignments/[assignmentId]/archive/route";
import { PUT as setDefault } from "@/app/api/v1/tenants/[tenantId]/pricing/default-price-list/route";
import {
  GET as entriesGet,
  POST as entriesPost,
} from "@/app/api/v1/tenants/[tenantId]/pricing/price-list-entries/route";
import {
  GET as entryGet,
  PATCH as entryPatch,
} from "@/app/api/v1/tenants/[tenantId]/pricing/price-list-entries/[entryId]/route";
import { POST as entryClose } from "@/app/api/v1/tenants/[tenantId]/pricing/price-list-entries/[entryId]/close/route";
import { GET as resolveGet } from "@/app/api/v1/tenants/[tenantId]/pricing/effective-price/route";
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
      if (!pricingApiAuth.userId) throw new UnauthenticatedError();
      return actual.getAccessContext(
        pricingApiAuth.userId,
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

describe("P2D.3b pricing API permissions", () => {
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

  const matrix: Array<{
    name: string;
    permission: string;
    neighbor: string;
    success: number;
    write: boolean;
    run: (input: {
      base: string;
      tenantId: string;
      priceListId: string;
      priceListVersion: number;
      extraListId: string;
      extraListVersion: number;
      assignListId: string;
      assignmentId: string;
      assignmentVersion: number;
      extraAssignmentId: string;
      extraAssignmentVersion: number;
      entryId: string;
      entryVersion: number;
      closeEntryId: string;
      closeEntryVersion: number;
      itemId: string;
      itemAssignmentId: string;
      leA: string;
      leB: string;
    }) => {
      handler: LooseHandler;
      req: Request;
      params: { tenantId: string } & Record<string, string>;
    };
  }> = [
    {
      name: "GET /pricing/price-lists",
      permission: PERMISSIONS.PRICE_LIST_READ,
      neighbor: PERMISSIONS.PRICE_LIST_CREATE,
      success: 200,
      write: false,
      run: ({ base, tenantId }) => ({
        handler: listsGet as unknown as LooseHandler,
        req: request(`${base}/pricing/price-lists`),
        params: { tenantId },
      }),
    },
    {
      name: "POST /pricing/price-lists",
      permission: PERMISSIONS.PRICE_LIST_CREATE,
      neighbor: PERMISSIONS.PRICE_LIST_UPDATE,
      success: 201,
      write: true,
      run: ({ base, tenantId, leA }) => ({
        handler: listsPost as unknown as LooseHandler,
        req: request(`${base}/pricing/price-lists`, {
          method: "POST",
          json: {
            ownerLegalEntityId: leA,
            code: catalogCode("PL"),
            name: "Perm list",
            currency: "SGD",
            permissions: [PERMISSIONS.PRICE_LIST_CREATE],
            actingUserId: "forged",
          },
        }),
        params: { tenantId },
      }),
    },
    {
      name: "GET /pricing/price-lists/{id}",
      permission: PERMISSIONS.PRICE_LIST_READ,
      neighbor: PERMISSIONS.PRICE_LIST_UPDATE,
      success: 200,
      write: false,
      run: ({ base, tenantId, priceListId }) => ({
        handler: listGet as unknown as LooseHandler,
        req: request(`${base}/pricing/price-lists/${priceListId}`),
        params: { tenantId, priceListId },
      }),
    },
    {
      name: "PATCH /pricing/price-lists/{id}",
      permission: PERMISSIONS.PRICE_LIST_UPDATE,
      neighbor: PERMISSIONS.PRICE_LIST_TRANSFER_OWNERSHIP,
      success: 200,
      write: true,
      run: ({ base, tenantId, extraListId, extraListVersion }) => ({
        handler: listPatch as unknown as LooseHandler,
        req: request(`${base}/pricing/price-lists/${extraListId}`, {
          method: "PATCH",
          json: { expectedVersion: extraListVersion, name: "Renamed" },
        }),
        params: { tenantId, priceListId: extraListId },
      }),
    },
    {
      name: "POST /pricing/price-lists/{id}/ownership-transfer",
      permission: PERMISSIONS.PRICE_LIST_TRANSFER_OWNERSHIP,
      neighbor: PERMISSIONS.PRICE_LIST_UPDATE,
      success: 200,
      write: true,
      run: ({ base, tenantId, extraListId, extraListVersion, leB }) => ({
        handler: listTransfer as unknown as LooseHandler,
        req: request(`${base}/pricing/price-lists/${extraListId}/ownership-transfer`, {
          method: "POST",
          json: { newOwnerLegalEntityId: leB, expectedVersion: extraListVersion },
        }),
        params: { tenantId, priceListId: extraListId },
      }),
    },
    {
      name: "GET /pricing/price-list-assignments",
      permission: PERMISSIONS.PRICE_LIST_ASSIGNMENT_READ,
      neighbor: PERMISSIONS.PRICE_LIST_ASSIGNMENT_CREATE,
      success: 200,
      write: false,
      run: ({ base, tenantId }) => ({
        handler: assignmentsGet as unknown as LooseHandler,
        req: request(`${base}/pricing/price-list-assignments`),
        params: { tenantId },
      }),
    },
    {
      name: "POST /pricing/price-list-assignments",
      permission: PERMISSIONS.PRICE_LIST_ASSIGNMENT_CREATE,
      neighbor: PERMISSIONS.PRICE_LIST_ASSIGNMENT_UPDATE,
      success: 201,
      write: true,
      run: ({ base, tenantId, assignListId, leB }) => ({
        handler: assignmentsPost as unknown as LooseHandler,
        req: request(`${base}/pricing/price-list-assignments`, {
          method: "POST",
          json: {
            priceListId: assignListId,
            legalEntityId: leB,
            permissions: [PERMISSIONS.PRICE_LIST_ASSIGNMENT_CREATE],
          },
        }),
        params: { tenantId },
      }),
    },
    {
      name: "GET /pricing/price-list-assignments/{id}",
      permission: PERMISSIONS.PRICE_LIST_ASSIGNMENT_READ,
      neighbor: PERMISSIONS.PRICE_LIST_ASSIGNMENT_UPDATE,
      success: 200,
      write: false,
      run: ({ base, tenantId, assignmentId }) => ({
        handler: assignmentGet as unknown as LooseHandler,
        req: request(`${base}/pricing/price-list-assignments/${assignmentId}`),
        params: { tenantId, assignmentId },
      }),
    },
    {
      name: "PATCH /pricing/price-list-assignments/{id}",
      permission: PERMISSIONS.PRICE_LIST_ASSIGNMENT_UPDATE,
      neighbor: PERMISSIONS.PRICE_LIST_ASSIGNMENT_ARCHIVE,
      success: 200,
      write: true,
      run: ({ base, tenantId, extraAssignmentId, extraAssignmentVersion }) => ({
        handler: assignmentPatch as unknown as LooseHandler,
        req: request(`${base}/pricing/price-list-assignments/${extraAssignmentId}`, {
          method: "PATCH",
          json: { expectedVersion: extraAssignmentVersion },
        }),
        params: { tenantId, assignmentId: extraAssignmentId },
      }),
    },
    {
      name: "POST /pricing/price-list-assignments/{id}/archive",
      permission: PERMISSIONS.PRICE_LIST_ASSIGNMENT_ARCHIVE,
      neighbor: PERMISSIONS.PRICE_LIST_ASSIGNMENT_UPDATE,
      success: 200,
      write: true,
      run: ({ base, tenantId, extraAssignmentId, extraAssignmentVersion }) => ({
        handler: assignmentArchive as unknown as LooseHandler,
        req: request(
          `${base}/pricing/price-list-assignments/${extraAssignmentId}/archive`,
          {
            method: "POST",
            json: { expectedVersion: extraAssignmentVersion },
          },
        ),
        params: { tenantId, assignmentId: extraAssignmentId },
      }),
    },
    {
      name: "PUT /pricing/default-price-list",
      permission: PERMISSIONS.PRICE_LIST_ASSIGNMENT_SET_DEFAULT,
      neighbor: PERMISSIONS.PRICE_LIST_ASSIGNMENT_UPDATE,
      success: 200,
      write: true,
      run: ({ base, tenantId, extraListId, leA }) => ({
        handler: setDefault as unknown as LooseHandler,
        req: request(`${base}/pricing/default-price-list`, {
          method: "PUT",
          json: { legalEntityId: leA, priceListId: extraListId },
        }),
        params: { tenantId },
      }),
    },
    {
      name: "GET /pricing/price-list-entries",
      permission: PERMISSIONS.PRICE_LIST_ENTRY_READ,
      neighbor: PERMISSIONS.PRICE_LIST_ENTRY_CREATE,
      success: 200,
      write: false,
      run: ({ base, tenantId }) => ({
        handler: entriesGet as unknown as LooseHandler,
        req: request(`${base}/pricing/price-list-entries`),
        params: { tenantId },
      }),
    },
    {
      name: "POST /pricing/price-list-entries",
      permission: PERMISSIONS.PRICE_LIST_ENTRY_CREATE,
      neighbor: PERMISSIONS.PRICE_LIST_ENTRY_UPDATE,
      success: 201,
      write: true,
      run: ({ base, tenantId, assignmentId, itemAssignmentId }) => ({
        handler: entriesPost as unknown as LooseHandler,
        req: request(`${base}/pricing/price-list-entries`, {
          method: "POST",
          json: {
            priceListAssignmentId: assignmentId,
            catalogItemAssignmentId: itemAssignmentId,
            unitPrice: "2",
            effectiveFrom: "2026-11-01",
            effectiveTo: "2026-11-30",
            legalEntityId: "forged",
          },
        }),
        params: { tenantId },
      }),
    },
    {
      name: "GET /pricing/price-list-entries/{id}",
      permission: PERMISSIONS.PRICE_LIST_ENTRY_READ,
      neighbor: PERMISSIONS.PRICE_LIST_ENTRY_UPDATE,
      success: 200,
      write: false,
      run: ({ base, tenantId, entryId }) => ({
        handler: entryGet as unknown as LooseHandler,
        req: request(`${base}/pricing/price-list-entries/${entryId}`),
        params: { tenantId, entryId },
      }),
    },
    {
      name: "PATCH /pricing/price-list-entries/{id}",
      permission: PERMISSIONS.PRICE_LIST_ENTRY_UPDATE,
      neighbor: PERMISSIONS.PRICE_LIST_ENTRY_CLOSE,
      success: 200,
      write: true,
      run: ({ base, tenantId, entryId, entryVersion }) => ({
        handler: entryPatch as unknown as LooseHandler,
        req: request(`${base}/pricing/price-list-entries/${entryId}`, {
          method: "PATCH",
          json: { expectedVersion: entryVersion, unitPrice: "3" },
        }),
        params: { tenantId, entryId },
      }),
    },
    {
      name: "POST /pricing/price-list-entries/{id}/close",
      permission: PERMISSIONS.PRICE_LIST_ENTRY_CLOSE,
      neighbor: PERMISSIONS.PRICE_LIST_ENTRY_UPDATE,
      success: 200,
      write: true,
      run: ({ base, tenantId, closeEntryId, closeEntryVersion }) => ({
        handler: entryClose as unknown as LooseHandler,
        req: request(`${base}/pricing/price-list-entries/${closeEntryId}/close`, {
          method: "POST",
          json: { expectedVersion: closeEntryVersion, effectiveTo: "2026-09-15" },
        }),
        params: { tenantId, entryId: closeEntryId },
      }),
    },
    {
      name: "GET /pricing/effective-price",
      permission: PERMISSIONS.PRICE_RESOLVE,
      neighbor: PERMISSIONS.PRICE_LIST_ENTRY_READ,
      success: 200,
      write: false,
      run: ({ base, tenantId, extraListId, itemId, leA }) => ({
        handler: resolveGet as unknown as LooseHandler,
        req: request(
          `${base}/pricing/effective-price?legalEntityId=${leA}&catalogItemId=${itemId}&onDate=2026-10-10&priceListId=${extraListId}`,
        ),
        params: { tenantId },
      }),
    },
  ];

  it("covers exact, absent and neighbouring permissions for all 17 operations", async () => {
    fixture = await setupPricingDomainFixture();
    const { setup, ctxAB, leA, leB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const uom = await createTestUom(ctxAB);
    const item = await createTestItem(ctxAB, leA.id, uom.id);
    const list = await createTestPriceList(ctxAB, leA.id, "SGD", "Main");
    const extraList = await createTestPriceList(ctxAB, leA.id, "SGD", "Extra");
    const assignList = await createTestPriceList(ctxAB, leA.id, "SGD", "Assign target");
    const extraAssignment = await createPriceListAssignment(ctxAB, {
      priceListId: extraList.priceList.id,
      legalEntityId: leB.id,
    });
    const entry = await createPriceListEntry(ctxAB, {
      priceListAssignmentId: extraList.assignment.id,
      catalogItemAssignmentId: item.assignment.id,
      unitPrice: "1",
      effectiveFrom: "2026-10-01",
      effectiveTo: "2026-10-31",
    });
    const closeEntry = await createPriceListEntry(ctxAB, {
      priceListAssignmentId: extraList.assignment.id,
      catalogItemAssignmentId: item.assignment.id,
      unitPrice: "1",
      effectiveFrom: "2026-09-01",
      effectiveTo: "2026-09-30",
    });
    const none = await createActor(tenantId, setup.adminUserId, [], [leA.id, leB.id]);
    extraUsers.push(none.id);
    const snapshot = async () =>
      withTenantContext(
        { tenantId, legalEntityIds: ctxAB.legalEntityIds },
        async (tx) => ({
          lists: await tx.priceList.count({ where: { tenantId } }),
          assignments: await tx.priceListLegalEntityAssignment.count({
            where: { tenantId },
          }),
          entries: await tx.priceListEntry.count({ where: { tenantId } }),
          audits: await tx.auditEvent.count({ where: { tenantId } }),
        }),
      );

    for (const op of matrix) {
      const holder = await createActor(
        tenantId,
        setup.adminUserId,
        [op.permission],
        [leA.id, leB.id],
      );
      extraUsers.push(holder.id);
      const neighbor = await createActor(
        tenantId,
        setup.adminUserId,
        [op.neighbor],
        [leA.id, leB.id],
      );
      extraUsers.push(neighbor.id);
      const extraListFresh = await withTenantContext(
        { tenantId, legalEntityIds: ctxAB.legalEntityIds },
        (tx) => tx.priceList.findFirstOrThrow({ where: { id: extraList.priceList.id } }),
      );
      const extraAssignFresh = await withTenantContext(
        { tenantId, legalEntityIds: ctxAB.legalEntityIds },
        (tx) =>
          tx.priceListLegalEntityAssignment.findFirstOrThrow({
            where: { id: extraAssignment.id },
          }),
      );
      const entryFresh = await withTenantContext(
        { tenantId, legalEntityIds: ctxAB.legalEntityIds },
        (tx) => tx.priceListEntry.findFirstOrThrow({ where: { id: entry.id } }),
      );
      const closeFresh = await withTenantContext(
        { tenantId, legalEntityIds: ctxAB.legalEntityIds },
        (tx) => tx.priceListEntry.findFirstOrThrow({ where: { id: closeEntry.id } }),
      );
      const call = op.run({
        base,
        tenantId,
        priceListId: list.priceList.id,
        priceListVersion: list.priceList.version,
        extraListId: extraList.priceList.id,
        extraListVersion: extraListFresh.version,
        assignListId: assignList.priceList.id,
        assignmentId: extraList.assignment.id,
        assignmentVersion: extraList.assignment.version,
        extraAssignmentId: extraAssignment.id,
        extraAssignmentVersion: extraAssignFresh.version,
        entryId: entry.id,
        entryVersion: entryFresh.version,
        closeEntryId: closeEntry.id,
        closeEntryVersion: closeFresh.version,
        itemId: item.item.id,
        itemAssignmentId: item.assignment.id,
        leA: leA.id,
        leB: leB.id,
      });
      const before = await snapshot();
      const beforeBuckets = await writeBucketCounts(tenantId, none.id);
      pricingApiAuth.userId = none.id;
      expect(
        (await invokeLoose(call.handler, call.req.clone(), call.params)).status,
        `${op.name} absent`,
      ).toBe(403);
      pricingApiAuth.userId = neighbor.id;
      expect(
        (await invokeLoose(call.handler, call.req.clone(), call.params)).status,
        `${op.name} neighbor`,
      ).toBe(403);
      expect(await snapshot(), `${op.name} snapshot`).toEqual(before);
      if (op.write) {
        expect(await writeBucketCounts(tenantId, none.id)).toEqual(beforeBuckets);
      }
      pricingApiAuth.userId = holder.id;
      expect(
        (await invokeLoose(call.handler, call.req.clone(), call.params)).status,
        `${op.name} exact`,
      ).toBe(op.success);
    }
  }, 240_000);

  it("keeps entity-scoped create, list filter, set-default and resolve on the matching legal entity", async () => {
    fixture = await setupPricingDomainFixture();
    const { setup, leA, leB, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const listActor = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.PRICE_LIST_CREATE],
      [leA.id, leB.id],
      leB.id,
    );
    extraUsers.push(listActor.id);
    pricingApiAuth.userId = listActor.id;
    expect(
      (
        await invokeLoose(
          listsPost as unknown as LooseHandler,
          request(`${base}/pricing/price-lists`, {
            method: "POST",
            json: {
              ownerLegalEntityId: leB.id,
              code: catalogCode("PL"),
              name: "Scoped",
              currency: "MYR",
            },
          }),
          { tenantId },
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await invokeLoose(
          listsPost as unknown as LooseHandler,
          request(`${base}/pricing/price-lists`, {
            method: "POST",
            json: {
              ownerLegalEntityId: leA.id,
              code: catalogCode("PL"),
              name: "Wrong LE",
              currency: "SGD",
              permissions: [PERMISSIONS.PRICE_LIST_CREATE],
            },
          }),
          { tenantId },
        )
      ).status,
    ).toBe(403);

    const seeded = await createTestPriceList(ctxAB, leA.id);
    const assignActor = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.PRICE_LIST_ASSIGNMENT_CREATE, PERMISSIONS.PRICE_LIST_ASSIGNMENT_READ],
      [leA.id, leB.id],
      leB.id,
    );
    extraUsers.push(assignActor.id);
    pricingApiAuth.userId = assignActor.id;
    expect(
      (
        await invokeLoose(
          assignmentsPost as unknown as LooseHandler,
          request(`${base}/pricing/price-list-assignments`, {
            method: "POST",
            json: { priceListId: seeded.priceList.id, legalEntityId: leB.id },
          }),
          { tenantId },
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await invokeLoose(
          assignmentsPost as unknown as LooseHandler,
          request(`${base}/pricing/price-list-assignments`, {
            method: "POST",
            json: {
              priceListId: seeded.priceList.id,
              legalEntityId: leA.id,
              permissions: [PERMISSIONS.PRICE_LIST_ASSIGNMENT_CREATE],
            },
          }),
          { tenantId },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          assignmentsGet as unknown as LooseHandler,
          request(`${base}/pricing/price-list-assignments?legalEntityId=${leB.id}`),
          { tenantId },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await invokeLoose(
          assignmentsGet as unknown as LooseHandler,
          request(`${base}/pricing/price-list-assignments?legalEntityId=${leA.id}`),
          { tenantId },
        )
      ).status,
    ).toBe(403);

    const defaultActor = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.PRICE_LIST_ASSIGNMENT_SET_DEFAULT],
      [leA.id, leB.id],
      leB.id,
    );
    extraUsers.push(defaultActor.id);
    pricingApiAuth.userId = defaultActor.id;
    expect(
      (
        await invokeLoose(
          setDefault as unknown as LooseHandler,
          request(`${base}/pricing/default-price-list`, {
            method: "PUT",
            json: { legalEntityId: leB.id, priceListId: seeded.priceList.id },
          }),
          { tenantId },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await invokeLoose(
          setDefault as unknown as LooseHandler,
          request(`${base}/pricing/default-price-list`, {
            method: "PUT",
            json: { legalEntityId: leA.id, priceListId: seeded.priceList.id },
          }),
          { tenantId },
        )
      ).status,
    ).toBe(403);

    const uom = await createTestUom(ctxAB);
    const item = await createTestItem(ctxAB, leA.id, uom.id);
    await createCatalogItemAssignment(ctxAB, {
      catalogItemId: item.item.id,
      legalEntityId: leB.id,
    });
    const resolveActor = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.PRICE_RESOLVE],
      [leA.id, leB.id],
      leB.id,
    );
    extraUsers.push(resolveActor.id);
    pricingApiAuth.userId = resolveActor.id;
    expect(
      (
        await invokeLoose(
          resolveGet as unknown as LooseHandler,
          request(
            `${base}/pricing/effective-price?legalEntityId=${leB.id}&catalogItemId=${item.item.id}&onDate=2026-07-01&priceListId=${seeded.priceList.id}`,
          ),
          { tenantId },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await invokeLoose(
          resolveGet as unknown as LooseHandler,
          request(
            `${base}/pricing/effective-price?legalEntityId=${leA.id}&catalogItemId=${item.item.id}&onDate=2026-07-01&priceListId=${seeded.priceList.id}`,
          ),
          { tenantId },
        )
      ).status,
    ).toBe(403);
  }, 120_000);

  it("requires tenant-wide permission for unfiltered lists, id-derived ops, update/transfer and entry mutations", async () => {
    fixture = await setupPricingDomainFixture();
    const { setup, leA, leB, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const list = await createTestPriceList(ctxAB, leA.id);
    await createPriceListAssignment(ctxAB, {
      priceListId: list.priceList.id,
      legalEntityId: leB.id,
    });
    const uom = await createTestUom(ctxAB);
    const item = await createTestItem(ctxAB, leA.id, uom.id);
    const entry = await createPriceListEntry(ctxAB, {
      priceListAssignmentId: list.assignment.id,
      catalogItemAssignmentId: item.assignment.id,
      unitPrice: "1",
      effectiveFrom: "2026-07-01",
      effectiveTo: "2026-07-31",
    });
    const scoped = await createActor(
      tenantId,
      setup.adminUserId,
      [
        PERMISSIONS.PRICE_LIST_READ,
        PERMISSIONS.PRICE_LIST_UPDATE,
        PERMISSIONS.PRICE_LIST_TRANSFER_OWNERSHIP,
        PERMISSIONS.PRICE_LIST_ASSIGNMENT_READ,
        PERMISSIONS.PRICE_LIST_ASSIGNMENT_UPDATE,
        PERMISSIONS.PRICE_LIST_ASSIGNMENT_ARCHIVE,
        PERMISSIONS.PRICE_LIST_ENTRY_READ,
        PERMISSIONS.PRICE_LIST_ENTRY_CREATE,
        PERMISSIONS.PRICE_LIST_ENTRY_UPDATE,
        PERMISSIONS.PRICE_LIST_ENTRY_CLOSE,
      ],
      [leA.id, leB.id],
      leB.id,
    );
    extraUsers.push(scoped.id);
    pricingApiAuth.userId = scoped.id;
    expect(
      (
        await invokeLoose(
          listsGet as unknown as LooseHandler,
          request(`${base}/pricing/price-lists`),
          { tenantId },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          listPatch as unknown as LooseHandler,
          request(`${base}/pricing/price-lists/${list.priceList.id}`, {
            method: "PATCH",
            json: { expectedVersion: list.priceList.version, name: "Nope" },
          }),
          { tenantId, priceListId: list.priceList.id },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          listTransfer as unknown as LooseHandler,
          request(`${base}/pricing/price-lists/${list.priceList.id}/ownership-transfer`, {
            method: "POST",
            json: {
              newOwnerLegalEntityId: leB.id,
              expectedVersion: list.priceList.version,
            },
          }),
          { tenantId, priceListId: list.priceList.id },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          assignmentsGet as unknown as LooseHandler,
          request(`${base}/pricing/price-list-assignments`),
          { tenantId },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          assignmentGet as unknown as LooseHandler,
          request(`${base}/pricing/price-list-assignments/${list.assignment.id}`),
          { tenantId, assignmentId: list.assignment.id },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          entriesGet as unknown as LooseHandler,
          request(`${base}/pricing/price-list-entries`),
          { tenantId },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          entriesPost as unknown as LooseHandler,
          request(`${base}/pricing/price-list-entries`, {
            method: "POST",
            json: {
              priceListAssignmentId: list.assignment.id,
              catalogItemAssignmentId: item.assignment.id,
              unitPrice: "4",
              effectiveFrom: "2026-12-01",
              effectiveTo: "2026-12-31",
            },
          }),
          { tenantId },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          entryPatch as unknown as LooseHandler,
          request(`${base}/pricing/price-list-entries/${entry.id}`, {
            method: "PATCH",
            json: { expectedVersion: entry.version, unitPrice: "9" },
          }),
          { tenantId, entryId: entry.id },
        )
      ).status,
    ).toBe(403);
  }, 90_000);
});
