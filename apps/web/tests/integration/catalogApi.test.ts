import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { AUDIT_ACTIONS, verifyAuditChain } from "@noahark/audit";
import { withTenantContext } from "@noahark/db";
import {
  API_WRITE_TENANT,
  API_WRITE_TENANT_USER,
  apiWriteCanonicalKey,
  hashKey,
} from "@/lib/rateLimiter";
import { createSystemClient } from "@noahark/db/system";
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

function errorCode(body: Record<string, unknown>): string {
  return (body.error as { code: string }).code;
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

describe("P2D.3a catalog category and UOM APIs", () => {
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

  it("covers category and UOM CRUD, 1-A lifecycle, pagination, audit, CSRF and OpenAPI", async () => {
    fixture = await setupCatalogDomainFixture();
    const { setup, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const userId = setup.adminUserId;
    catalogApiAuth.userId = userId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const catCode = catalogCode("CAT");
    const createRequestId = uniqueSlug("rid");
    const beforeBuckets = await writeBucketCounts(tenantId, userId);

    const createdRes = await invoke(
      categoriesPost,
      request(`${base}/catalog/categories`, {
        method: "POST",
        headers: { "x-request-id": createRequestId },
        json: {
          code: catCode,
          name: "Hardware",
          permissions: ["catalog_category:create"],
          actingUserId: "forged",
          requestId: "forged-rid",
        },
      }),
      { tenantId },
    );
    expect(createdRes.status).toBe(201);
    const createdBody = await readJson(createdRes);
    assertMatchesOpenApi("createCatalogCategory", createdBody, ["category"]);
    const category = (
      createdBody.data as {
        category: {
          id: string;
          code: string;
          name: string;
          isActive: boolean;
          version: number;
        };
      }
    ).category;
    expect(category.code).toBe(catCode);
    expect(category.isActive).toBe(true);
    expect(category.version).toBe(1);
    expect(await writeBucketCounts(tenantId, userId)).toEqual({
      user: beforeBuckets.user + 1,
      tenant: beforeBuckets.tenant + 1,
    });

    const listRes = await invoke(categoriesGet, request(`${base}/catalog/categories`), {
      tenantId,
    });
    expect(listRes.status).toBe(200);
    const listBody = await readJson(listRes);
    assertMatchesOpenApi("listCatalogCategories", listBody, ["categories", "nextCursor"]);
    expect(
      (listBody.data as { categories: Array<{ id: string }> }).categories.some(
        (row) => row.id === category.id,
      ),
    ).toBe(true);

    const getRes = await invoke(
      categoryGet,
      request(`${base}/catalog/categories/${category.id}`),
      { tenantId, categoryId: category.id },
    );
    expect(getRes.status).toBe(200);
    assertMatchesOpenApi("getCatalogCategory", await readJson(getRes), ["category"]);

    const updatedRes = await invoke(
      categoryPatch,
      request(`${base}/catalog/categories/${category.id}`, {
        method: "PATCH",
        json: {
          expectedVersion: category.version,
          name: "Hardware renamed",
          ownerLegalEntityId: "should-strip",
        },
      }),
      { tenantId, categoryId: category.id },
    );
    expect(updatedRes.status).toBe(200);
    const updatedBody = await readJson(updatedRes);
    assertMatchesOpenApi("updateCatalogCategory", updatedBody, ["category"]);
    const updated = (
      updatedBody.data as { category: { name: string; version: number; code: string } }
    ).category;
    expect(updated.name).toBe("Hardware renamed");
    expect(updated.code).toBe(catCode);
    expect(updated.version).toBe(2);

    const immutable = await invoke(
      categoryPatch,
      request(`${base}/catalog/categories/${category.id}`, {
        method: "PATCH",
        json: { expectedVersion: updated.version, code: "NEWCODE" },
      }),
      { tenantId, categoryId: category.id },
    );
    expect(immutable.status).toBe(422);

    const duplicate = await invoke(
      categoriesPost,
      request(`${base}/catalog/categories`, {
        method: "POST",
        json: { code: catCode, name: "Dup" },
      }),
      { tenantId },
    );
    expect(duplicate.status).toBe(409);
    expect(errorCode(await readJson(duplicate))).toBe("CONFLICT");

    const stale = await invoke(
      categoryPatch,
      request(`${base}/catalog/categories/${category.id}`, {
        method: "PATCH",
        json: { expectedVersion: 1, name: "Stale" },
      }),
      { tenantId, categoryId: category.id },
    );
    expect(stale.status).toBe(409);
    const staleBody = await readJson(stale);
    expect(errorCode(staleBody)).toBe("STALE_VERSION");

    const deactivatedRes = await invoke(
      categoryDeactivate,
      request(`${base}/catalog/categories/${category.id}/deactivate`, {
        method: "POST",
        json: { expectedVersion: updated.version },
      }),
      { tenantId, categoryId: category.id },
    );
    expect(deactivatedRes.status).toBe(200);
    const deactivatedBody = await readJson(deactivatedRes);
    assertMatchesOpenApi("deactivateCatalogCategory", deactivatedBody, ["category"]);
    const deactivated = (
      deactivatedBody.data as { category: { isActive: boolean; version: number } }
    ).category;
    expect(deactivated.isActive).toBe(false);

    const defaultList = await invoke(
      categoriesGet,
      request(`${base}/catalog/categories`),
      { tenantId },
    );
    const defaultIds = (
      (await readJson(defaultList)).data as { categories: Array<{ id: string }> }
    ).categories.map((row) => row.id);
    expect(defaultIds).not.toContain(category.id);

    const inactiveList = await invoke(
      categoriesGet,
      request(`${base}/catalog/categories?isActive=false`),
      { tenantId },
    );
    const inactiveIds = (
      (await readJson(inactiveList)).data as { categories: Array<{ id: string }> }
    ).categories.map((row) => row.id);
    expect(inactiveIds).toContain(category.id);

    const alreadyInactive = await invoke(
      categoryDeactivate,
      request(`${base}/catalog/categories/${category.id}/deactivate`, {
        method: "POST",
        json: { expectedVersion: deactivated.version },
      }),
      { tenantId, categoryId: category.id },
    );
    expect(alreadyInactive.status).toBe(422);

    const extraStatusKey = await invoke(
      categoryDeactivate,
      request(`${base}/catalog/categories/${category.id}/deactivate`, {
        method: "POST",
        json: { expectedVersion: deactivated.version, extra: true },
      }),
      { tenantId, categoryId: category.id },
    );
    expect(extraStatusKey.status).toBe(422);

    const activatedRes = await invoke(
      categoryActivate,
      request(`${base}/catalog/categories/${category.id}/activate`, {
        method: "POST",
        json: { expectedVersion: deactivated.version },
      }),
      { tenantId, categoryId: category.id },
    );
    expect(activatedRes.status).toBe(200);
    const activatedBody = await readJson(activatedRes);
    assertMatchesOpenApi("activateCatalogCategory", activatedBody, ["category"]);
    expect(
      (activatedBody.data as { category: { isActive: boolean } }).category.isActive,
    ).toBe(true);

    const alreadyActive = await invoke(
      categoryActivate,
      request(`${base}/catalog/categories/${category.id}/activate`, {
        method: "POST",
        json: { expectedVersion: 4 },
      }),
      { tenantId, categoryId: category.id },
    );
    expect(alreadyActive.status).toBe(422);

    const categorySchema = OPENAPI_DOC.components?.schemas?.CatalogCategory;
    const brokenActive: OpenApiSchema = {
      ...categorySchema!,
      properties: {
        ...categorySchema!.properties,
        isActive: { type: "boolean", enum: [true] },
      },
    };
    expect(
      validateOpenApiValue(
        OPENAPI_DOC,
        brokenActive,
        (deactivatedBody.data as { category: unknown }).category,
        "broken-category-inactive",
      ).some((error) => error.includes("enum")),
    ).toBe(true);

    const uomCode = catalogCode("UOM");
    const uomCreate = await invoke(
      unitsPost,
      request(`${base}/catalog/units-of-measure`, {
        method: "POST",
        json: { code: uomCode, name: "Each" },
      }),
      { tenantId },
    );
    expect(uomCreate.status).toBe(201);
    const uomCreateBody = await readJson(uomCreate);
    assertMatchesOpenApi("createUnitOfMeasure", uomCreateBody, ["unit"]);
    const unit = (
      uomCreateBody.data as { unit: { id: string; version: number; code: string } }
    ).unit;

    const unitsList = await invoke(
      unitsGet,
      request(`${base}/catalog/units-of-measure`),
      { tenantId },
    );
    expect(unitsList.status).toBe(200);
    assertMatchesOpenApi("listUnitsOfMeasure", await readJson(unitsList), [
      "units",
      "nextCursor",
    ]);

    const unitGetRes = await invoke(
      unitGet,
      request(`${base}/catalog/units-of-measure/${unit.id}`),
      { tenantId, unitId: unit.id },
    );
    expect(unitGetRes.status).toBe(200);
    assertMatchesOpenApi("getUnitOfMeasure", await readJson(unitGetRes), ["unit"]);

    const unitUpdated = await invoke(
      unitPatch,
      request(`${base}/catalog/units-of-measure/${unit.id}`, {
        method: "PATCH",
        json: { expectedVersion: unit.version, name: "Piece" },
      }),
      { tenantId, unitId: unit.id },
    );
    expect(unitUpdated.status).toBe(200);
    const unitUpdatedBody = await readJson(unitUpdated);
    assertMatchesOpenApi("updateUnitOfMeasure", unitUpdatedBody, ["unit"]);
    const unitAfter = (
      unitUpdatedBody.data as { unit: { version: number; name: string } }
    ).unit;
    expect(unitAfter.name).toBe("Piece");

    const uomImmutable = await invoke(
      unitPatch,
      request(`${base}/catalog/units-of-measure/${unit.id}`, {
        method: "PATCH",
        json: { expectedVersion: unitAfter.version, code: "NEW" },
      }),
      { tenantId, unitId: unit.id },
    );
    expect(uomImmutable.status).toBe(422);

    const uomDup = await invoke(
      unitsPost,
      request(`${base}/catalog/units-of-measure`, {
        method: "POST",
        json: { code: uomCode, name: "Dup" },
      }),
      { tenantId },
    );
    expect(uomDup.status).toBe(409);

    const uomOff = await invoke(
      unitDeactivate,
      request(`${base}/catalog/units-of-measure/${unit.id}/deactivate`, {
        method: "POST",
        json: { expectedVersion: unitAfter.version },
      }),
      { tenantId, unitId: unit.id },
    );
    expect(uomOff.status).toBe(200);
    const uomOffBody = await readJson(uomOff);
    assertMatchesOpenApi("deactivateUnitOfMeasure", uomOffBody, ["unit"]);
    expect((uomOffBody.data as { unit: { isActive: boolean } }).unit.isActive).toBe(
      false,
    );

    const uomOn = await invoke(
      unitActivate,
      request(`${base}/catalog/units-of-measure/${unit.id}/activate`, {
        method: "POST",
        json: { expectedVersion: 3 },
      }),
      { tenantId, unitId: unit.id },
    );
    expect(uomOn.status).toBe(200);
    assertMatchesOpenApi("activateUnitOfMeasure", await readJson(uomOn), ["unit"]);

    expect(
      (
        await invoke(categoriesGet, request(`${base}/catalog/categories?unknown=1`), {
          tenantId,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await invoke(
          categoriesGet,
          request(`${base}/catalog/categories?limit=1&limit=2`),
          {
            tenantId,
          },
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await invoke(categoriesGet, request(`${base}/catalog/categories?limit=0`), {
          tenantId,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await invoke(categoriesGet, request(`${base}/catalog/categories?isActive=yes`), {
          tenantId,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await invoke(
          categoriesGet,
          request(`${base}/catalog/categories?cursor=not-a-cursor`),
          {
            tenantId,
          },
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await invoke(unitsGet, request(`${base}/catalog/units-of-measure?limit=abc`), {
          tenantId,
        })
      ).status,
    ).toBe(422);

    const malformed = await invoke(
      categoriesPost,
      new Request(`${base}/catalog/categories`, {
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

    for (let i = 0; i < 26; i += 1) {
      await createTestCategory(ctxAB, `Page ${i}`);
      await createTestUom(ctxAB, `Uom ${i}`);
    }
    const page1 = await invoke(
      categoriesGet,
      request(`${base}/catalog/categories?limit=25`),
      { tenantId },
    );
    const page1Body = (await readJson(page1)).data as {
      categories: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(page1Body.categories).toHaveLength(25);
    expect(page1Body.nextCursor).toBeTruthy();
    const page2 = await invoke(
      categoriesGet,
      request(
        `${base}/catalog/categories?limit=25&cursor=${encodeURIComponent(page1Body.nextCursor!)}`,
      ),
      { tenantId },
    );
    const page2Body = (await readJson(page2)).data as {
      categories: Array<{ id: string }>;
      nextCursor: string | null;
    };
    const catIds = [...page1Body.categories, ...page2Body.categories].map(
      (row) => row.id,
    );
    expect(new Set(catIds).size).toBe(catIds.length);
    const capped = await invoke(
      categoriesGet,
      request(`${base}/catalog/categories?limit=1000`),
      { tenantId },
    );
    expect(
      ((await readJson(capped)).data as { categories: unknown[] }).categories.length,
    ).toBeLessThanOrEqual(100);

    const uomPage = await invoke(
      unitsGet,
      request(`${base}/catalog/units-of-measure?limit=25`),
      { tenantId },
    );
    const uomPageBody = (await readJson(uomPage)).data as {
      units: unknown[];
      nextCursor: string | null;
    };
    expect(uomPageBody.units).toHaveLength(25);
    expect(uomPageBody.nextCursor).toBeTruthy();

    const csrfBefore = await writeBucketCounts(tenantId, userId);
    const csrfState = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        categories: await tx.catalogCategory.count({ where: { tenantId } }),
        units: await tx.unitOfMeasure.count({ where: { tenantId } }),
        audits: await tx.auditEvent.count({ where: { tenantId } }),
      }),
    );
    const csrfCat = await invoke(
      categoriesPost,
      request(`${base}/catalog/categories`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        json: { code: catalogCode("X"), name: "Evil" },
      }),
      { tenantId },
    );
    const csrfUom = await invoke(
      unitPatch,
      request(`${base}/catalog/units-of-measure/${unit.id}`, {
        method: "PATCH",
        headers: { Origin: "https://evil.example" },
        json: { expectedVersion: 4, name: "Hijack" },
      }),
      { tenantId, unitId: unit.id },
    );
    const csrfDeact = await invoke(
      categoryDeactivate,
      request(`${base}/catalog/categories/${category.id}/deactivate`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        json: { expectedVersion: 4 },
      }),
      { tenantId, categoryId: category.id },
    );
    expect(csrfCat.status).toBe(403);
    expect(csrfUom.status).toBe(403);
    expect(csrfDeact.status).toBe(403);
    expect(await writeBucketCounts(tenantId, userId)).toEqual(csrfBefore);
    expect(
      await withTenantContext(
        { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
        async (tx) => ({
          categories: await tx.catalogCategory.count({ where: { tenantId } }),
          units: await tx.unitOfMeasure.count({ where: { tenantId } }),
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
    const createdAudit = audits.find(
      (row) =>
        row.action === AUDIT_ACTIONS.CATALOG_CATEGORY_CREATED &&
        row.entityId === category.id,
    );
    expect(createdAudit?.requestId).toBe(createRequestId);
    expect(createdAudit?.actorUserId).toBe(userId);
    expect(audits.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        AUDIT_ACTIONS.CATALOG_CATEGORY_CREATED,
        AUDIT_ACTIONS.CATALOG_CATEGORY_UPDATED,
        AUDIT_ACTIONS.CATALOG_CATEGORY_DEACTIVATED,
        AUDIT_ACTIONS.CATALOG_CATEGORY_ACTIVATED,
        AUDIT_ACTIONS.UNIT_OF_MEASURE_CREATED,
        AUDIT_ACTIONS.UNIT_OF_MEASURE_UPDATED,
        AUDIT_ACTIONS.UNIT_OF_MEASURE_DEACTIVATED,
        AUDIT_ACTIONS.UNIT_OF_MEASURE_ACTIVATED,
      ]),
    );
    expect(JSON.stringify(staleBody)).not.toMatch(/P2002|23505|sqlState/i);
  }, 120_000);
});
