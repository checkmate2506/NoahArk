import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { AUDIT_ACTIONS, verifyAuditChain } from "@noahark/audit";
import { withTenantContext } from "@noahark/db";
import {
  createCatalogCategory,
  createCatalogItem,
  createUnitOfMeasure,
  deactivateCatalogCategory,
  deactivateUnitOfMeasure,
} from "@/lib/services/catalogDomain";
import {
  API_WRITE_TENANT,
  API_WRITE_TENANT_USER,
  apiWriteCanonicalKey,
  hashKey,
} from "@/lib/rateLimiter";
import { createSystemClient } from "@noahark/db/system";
import {
  GET as itemsGet,
  POST as itemsPost,
} from "@/app/api/v1/tenants/[tenantId]/catalog/items/route";
import {
  GET as itemGet,
  PATCH as itemPatch,
} from "@/app/api/v1/tenants/[tenantId]/catalog/items/[catalogItemId]/route";
import { POST as itemTransfer } from "@/app/api/v1/tenants/[tenantId]/catalog/items/[catalogItemId]/ownership-transfer/route";
import { cleanupTenant, cleanupUser, uniqueSlug } from "./testHelpers";
import {
  catalogCode,
  createTestCategory,
  createTestUom,
  setupCatalogDomainFixture,
  type CatalogDomainFixture,
} from "./catalogDomainFixture";
import {
  OPENAPI_DOC,
  type OpenApiSchema,
  assertMatchesOpenApi,
  validateOpenApiValue,
} from "./openapiResponseValidator";

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

describe("P2D.3a CatalogItem APIs", () => {
  let fixture: CatalogDomainFixture | undefined;

  afterEach(async () => {
    catalogApiAuth.userId = undefined;
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("covers atomic bootstrap, update semantics, transfer, pagination, CSRF and OpenAPI", async () => {
    fixture = await setupCatalogDomainFixture();
    const { setup, leA, leB, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const userId = setup.adminUserId;
    catalogApiAuth.userId = userId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const category = await createTestCategory(ctxAB);
    const uom = await createTestUom(ctxAB);
    const itemCode = catalogCode("SKU");
    const createRequestId = uniqueSlug("rid");
    const beforeBuckets = await writeBucketCounts(tenantId, userId);

    const createdRes = await invoke(
      itemsPost,
      request(`${base}/catalog/items`, {
        method: "POST",
        headers: { "x-request-id": createRequestId },
        json: {
          ownerLegalEntityId: leA.id,
          code: itemCode,
          itemType: "PRODUCT",
          name: "Bolt",
          baseUomId: uom.id,
          categoryId: category.id,
          permissions: ["catalog_item:create"],
          actingUserId: "forged",
          requestId: "forged-rid",
        },
      }),
      { tenantId },
    );
    expect(createdRes.status).toBe(201);
    const createdBody = await readJson(createdRes);
    assertMatchesOpenApi("createCatalogItem", createdBody, ["item", "assignment"]);
    const created = createdBody.data as {
      item: {
        id: string;
        ownerLegalEntityId: string;
        description: string | null;
        categoryId: string | null;
        version: number;
        status: string;
      };
      assignment: {
        id: string;
        legalEntityId: string;
        catalogItemId: string;
        status: string;
      };
    };
    expect(created.item.ownerLegalEntityId).toBe(leA.id);
    expect(created.item.description).toBeNull();
    expect(created.item.categoryId).toBe(category.id);
    expect(created.item.status).toBe("ACTIVE");
    expect(created.assignment.legalEntityId).toBe(leA.id);
    expect(created.assignment.catalogItemId).toBe(created.item.id);
    expect(created.assignment.status).toBe("ACTIVE");
    expect(await writeBucketCounts(tenantId, userId)).toEqual({
      user: beforeBuckets.user + 1,
      tenant: beforeBuckets.tenant + 1,
    });

    const itemSchema = OPENAPI_DOC.components?.schemas?.CatalogItem;
    const brokenNullable: OpenApiSchema = {
      ...itemSchema!,
      properties: {
        ...itemSchema!.properties,
        description: { type: "string" },
      },
    };
    expect(
      validateOpenApiValue(
        OPENAPI_DOC,
        brokenNullable,
        created.item,
        "broken-item-description",
      ).some((error) => error.includes("type")),
    ).toBe(true);

    const getRes = await invoke(
      itemGet,
      request(`${base}/catalog/items/${created.item.id}`),
      { tenantId, catalogItemId: created.item.id },
    );
    expect(getRes.status).toBe(200);
    assertMatchesOpenApi("getCatalogItem", await readJson(getRes), ["item"]);

    const named = await invoke(
      itemPatch,
      request(`${base}/catalog/items/${created.item.id}`, {
        method: "PATCH",
        json: { expectedVersion: created.item.version, name: "Bolt M8" },
      }),
      { tenantId, catalogItemId: created.item.id },
    );
    expect(named.status).toBe(200);
    const namedBody = await readJson(named);
    assertMatchesOpenApi("updateCatalogItem", namedBody, ["item"]);
    const afterName = (
      namedBody.data as {
        item: { version: number; description: string | null; name: string };
      }
    ).item;
    expect(afterName.name).toBe("Bolt M8");
    expect(afterName.description).toBeNull();

    const described = await invoke(
      itemPatch,
      request(`${base}/catalog/items/${created.item.id}`, {
        method: "PATCH",
        json: { expectedVersion: afterName.version, description: "Steel bolt" },
      }),
      { tenantId, catalogItemId: created.item.id },
    );
    const afterDesc = (
      (await readJson(described)).data as {
        item: { version: number; description: string | null };
      }
    ).item;
    expect(afterDesc.description).toBe("Steel bolt");

    const cleared = await invoke(
      itemPatch,
      request(`${base}/catalog/items/${created.item.id}`, {
        method: "PATCH",
        json: { expectedVersion: afterDesc.version, description: null },
      }),
      { tenantId, catalogItemId: created.item.id },
    );
    const afterClear = (
      (await readJson(cleared)).data as {
        item: { version: number; description: string | null; ownerLegalEntityId: string };
      }
    ).item;
    expect(afterClear.description).toBeNull();

    const stealOwner = await invoke(
      itemPatch,
      request(`${base}/catalog/items/${created.item.id}`, {
        method: "PATCH",
        json: {
          expectedVersion: afterClear.version,
          ownerLegalEntityId: leB.id,
          name: "Still owned by A",
        },
      }),
      { tenantId, catalogItemId: created.item.id },
    );
    expect(stealOwner.status).toBe(200);
    const afterSteal = (
      (await readJson(stealOwner)).data as {
        item: { ownerLegalEntityId: string; version: number; name: string };
      }
    ).item;
    expect(afterSteal.ownerLegalEntityId).toBe(leA.id);
    expect(afterSteal.name).toBe("Still owned by A");

    const inactiveCat = await createCatalogCategory(ctxAB, {
      code: catalogCode("CAT"),
      name: "Inactive",
    });
    await deactivateCatalogCategory(ctxAB, inactiveCat.id, {
      expectedVersion: inactiveCat.version,
    });
    const inactiveUom = await createUnitOfMeasure(ctxAB, {
      code: catalogCode("UOM"),
      name: "Dead",
    });
    await deactivateUnitOfMeasure(ctxAB, inactiveUom.id, {
      expectedVersion: inactiveUom.version,
    });
    const badCat = await invoke(
      itemsPost,
      request(`${base}/catalog/items`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: catalogCode("SKU"),
          itemType: "PRODUCT",
          name: "Bad cat",
          baseUomId: uom.id,
          categoryId: inactiveCat.id,
        },
      }),
      { tenantId },
    );
    expect(badCat.status).toBe(422);
    const badUom = await invoke(
      itemsPost,
      request(`${base}/catalog/items`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: catalogCode("SKU"),
          itemType: "SERVICE",
          name: "Bad uom",
          baseUomId: inactiveUom.id,
        },
      }),
      { tenantId },
    );
    expect(badUom.status).toBe(422);

    await deactivateCatalogCategory(ctxAB, category.id, {
      expectedVersion: category.version,
    });
    const echoCat = await invoke(
      itemPatch,
      request(`${base}/catalog/items/${created.item.id}`, {
        method: "PATCH",
        json: { expectedVersion: afterSteal.version, name: "Historic cat still valid" },
      }),
      { tenantId, catalogItemId: created.item.id },
    );
    expect(echoCat.status).toBe(200);
    const afterEcho = (
      (await readJson(echoCat)).data as {
        item: { version: number; categoryId: string | null };
      }
    ).item;
    expect(afterEcho.categoryId).toBe(category.id);

    const changeToInactive = await invoke(
      itemPatch,
      request(`${base}/catalog/items/${created.item.id}`, {
        method: "PATCH",
        json: { expectedVersion: afterEcho.version, categoryId: inactiveCat.id },
      }),
      { tenantId, catalogItemId: created.item.id },
    );
    expect(changeToInactive.status).toBe(422);

    const transferRes = await invoke(
      itemTransfer,
      request(`${base}/catalog/items/${created.item.id}/ownership-transfer`, {
        method: "POST",
        json: { newOwnerLegalEntityId: leB.id, expectedVersion: afterEcho.version },
      }),
      { tenantId, catalogItemId: created.item.id },
    );
    expect(transferRes.status).toBe(200);
    const transferBody = await readJson(transferRes);
    assertMatchesOpenApi("transferCatalogItemOwnership", transferBody, ["item"]);
    expect(
      (transferBody.data as { item: { ownerLegalEntityId: string } }).item
        .ownerLegalEntityId,
    ).toBe(leB.id);
    const assignments = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) =>
        tx.catalogItemLegalEntityAssignment.findMany({
          where: { catalogItemId: created.item.id },
          orderBy: { id: "asc" },
        }),
    );
    expect(assignments.map((row) => row.legalEntityId)).toEqual([leA.id]);

    const malformed = await invoke(
      itemsPost,
      new Request(`${base}/catalog/items`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": uniqueSlug("rid"),
        },
        body: "{not-json",
      }),
      { tenantId },
    );
    expect(malformed.status).toBe(422);

    const product = catalogCode("PRD");
    const service = catalogCode("SRV");
    await createCatalogItem(ctxAB, {
      ownerLegalEntityId: leA.id,
      code: product,
      itemType: "PRODUCT",
      name: "Filter product",
      baseUomId: uom.id,
    });
    await createCatalogItem(ctxAB, {
      ownerLegalEntityId: leA.id,
      code: service,
      itemType: "SERVICE",
      name: "Filter service",
      baseUomId: uom.id,
    });
    const typed = await invoke(
      itemsGet,
      request(`${base}/catalog/items?itemType=SERVICE`),
      { tenantId },
    );
    expect(typed.status).toBe(200);
    const typedBody = await readJson(typed);
    assertMatchesOpenApi("listCatalogItems", typedBody, ["items", "nextCursor"]);
    const typedItems = (
      typedBody.data as { items: Array<{ itemType: string; code: string }> }
    ).items;
    expect(typedItems.every((row) => row.itemType === "SERVICE")).toBe(true);
    expect(typedItems.some((row) => row.code === service)).toBe(true);
    expect(typedItems.some((row) => row.code === product)).toBe(false);

    const qList = await invoke(
      itemsGet,
      request(`${base}/catalog/items?q=${encodeURIComponent(product.slice(0, 8))}`),
      { tenantId },
    );
    expect(
      ((await readJson(qList)).data as { items: Array<{ code: string }> }).items.some(
        (row) => row.code === product,
      ),
    ).toBe(true);

    for (let i = 0; i < 26; i += 1) {
      await createCatalogItem(ctxAB, {
        ownerLegalEntityId: leA.id,
        code: catalogCode("PG"),
        itemType: "PRODUCT",
        name: `Page ${i}`,
        baseUomId: uom.id,
      });
    }
    const page1 = await invoke(itemsGet, request(`${base}/catalog/items?limit=25`), {
      tenantId,
    });
    const page1Body = (await readJson(page1)).data as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(page1Body.items).toHaveLength(25);
    expect(page1Body.nextCursor).toBeTruthy();
    const page2 = await invoke(
      itemsGet,
      request(
        `${base}/catalog/items?limit=25&cursor=${encodeURIComponent(page1Body.nextCursor!)}`,
      ),
      { tenantId },
    );
    const page2Body = (await readJson(page2)).data as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    const ids = [...page1Body.items, ...page2Body.items].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    const last = await invoke(
      itemsGet,
      request(
        `${base}/catalog/items?limit=100&cursor=${encodeURIComponent(page2Body.nextCursor ?? page1Body.nextCursor!)}`,
      ),
      { tenantId },
    );
    const lastBody = (await readJson(last)).data as { nextCursor: string | null };
    if (page2Body.nextCursor) {
      expect(
        lastBody.nextCursor === null || typeof lastBody.nextCursor === "string",
      ).toBe(true);
    }
    const capped = await invoke(itemsGet, request(`${base}/catalog/items?limit=500`), {
      tenantId,
    });
    expect(
      ((await readJson(capped)).data as { items: unknown[] }).items.length,
    ).toBeLessThanOrEqual(100);
    expect(
      (await invoke(itemsGet, request(`${base}/catalog/items?limit=0`), { tenantId }))
        .status,
    ).toBe(422);
    expect(
      (
        await invoke(itemsGet, request(`${base}/catalog/items?includeArchived=1`), {
          tenantId,
        })
      ).status,
    ).toBe(422);

    const csrfBefore = await writeBucketCounts(tenantId, userId);
    const csrfState = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        items: await tx.catalogItem.count({ where: { tenantId } }),
        audits: await tx.auditEvent.count({ where: { tenantId } }),
      }),
    );
    const csrfCreate = await invoke(
      itemsPost,
      request(`${base}/catalog/items`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        json: {
          ownerLegalEntityId: leA.id,
          code: catalogCode("SKU"),
          itemType: "PRODUCT",
          name: "Evil",
          baseUomId: uom.id,
        },
      }),
      { tenantId },
    );
    const csrfUpdate = await invoke(
      itemPatch,
      request(`${base}/catalog/items/${created.item.id}`, {
        method: "PATCH",
        headers: { Origin: "https://evil.example" },
        json: { expectedVersion: afterEcho.version, name: "Hijack" },
      }),
      { tenantId, catalogItemId: created.item.id },
    );
    const csrfTransfer = await invoke(
      itemTransfer,
      request(`${base}/catalog/items/${created.item.id}/ownership-transfer`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        json: { newOwnerLegalEntityId: leA.id, expectedVersion: afterEcho.version },
      }),
      { tenantId, catalogItemId: created.item.id },
    );
    expect(csrfCreate.status).toBe(403);
    expect(csrfUpdate.status).toBe(403);
    expect(csrfTransfer.status).toBe(403);
    expect(await writeBucketCounts(tenantId, userId)).toEqual(csrfBefore);
    expect(
      await withTenantContext(
        { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
        async (tx) => ({
          items: await tx.catalogItem.count({ where: { tenantId } }),
          audits: await tx.auditEvent.count({ where: { tenantId } }),
        }),
      ),
    ).toEqual(csrfState);

    const audits = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) =>
        tx.auditEvent.findMany({ where: { tenantId }, orderBy: { sequence: "asc" } }),
    );
    expect(verifyAuditChain(toLinks(audits)).valid).toBe(true);
    const itemCreated = audits.find(
      (row) =>
        row.action === AUDIT_ACTIONS.CATALOG_ITEM_CREATED &&
        row.entityId === created.item.id,
    );
    expect(itemCreated?.requestId).toBe(createRequestId);
    expect(itemCreated?.actorUserId).toBe(userId);
    expect(
      audits.some(
        (row) =>
          row.action === AUDIT_ACTIONS.CATALOG_ITEM_ASSIGNMENT_CREATED &&
          row.entityId === created.assignment.id,
      ),
    ).toBe(true);
    expect(
      audits.some(
        (row) =>
          row.action === AUDIT_ACTIONS.CATALOG_ITEM_OWNERSHIP_TRANSFERRED &&
          row.entityId === created.item.id,
      ),
    ).toBe(true);
    expect(
      audits.filter(
        (row) =>
          row.action === AUDIT_ACTIONS.CATALOG_ITEM_CREATED &&
          row.entityId === created.item.id,
      ),
    ).toHaveLength(1);
  }, 120_000);
});
