import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { withTenantContext } from "@noahark/db";
import {
  createCatalogItemAssignment,
  createPriceListAssignment,
  setDefaultPriceList,
  updateCatalogItemAssignment,
  updatePriceListAssignment,
} from "@/lib/services/catalogDomain";
import { GET as resolveGet } from "@/app/api/v1/tenants/[tenantId]/pricing/effective-price/route";
import { POST as entriesPost } from "@/app/api/v1/tenants/[tenantId]/pricing/price-list-entries/route";
import {
  API_WRITE_TENANT,
  API_WRITE_TENANT_USER,
  apiWriteCanonicalKey,
  hashKey,
} from "@/lib/rateLimiter";
import { createSystemClient } from "@noahark/db/system";
import { cleanupTenant, cleanupUser, uniqueSlug } from "./testHelpers";
import {
  createTestItem,
  createTestPriceList,
  createTestUom,
  setupPricingDomainFixture,
  type PricingDomainFixture,
} from "./pricingDomainFixture";
import {
  OPENAPI_DOC,
  type OpenApiSchema,
  assertMatchesOpenApi,
  validateOpenApiValue,
} from "./openapiResponseValidator";

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

describe("P2D.3b effective-price API", () => {
  let fixture: PricingDomainFixture | undefined;

  afterEach(async () => {
    pricingApiAuth.userId = undefined;
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("resolves covering rows, returns 200 when unresolved, and 404 uniformly otherwise", async () => {
    fixture = await setupPricingDomainFixture();
    const { setup, ctxAB, leA, leB } = fixture;
    const tenantId = setup.tenantId;
    const userId = setup.adminUserId;
    pricingApiAuth.userId = userId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const uom = await createTestUom(ctxAB);
    const item = await createTestItem(ctxAB, leA.id, uom.id);
    await createCatalogItemAssignment(ctxAB, {
      catalogItemId: item.item.id,
      legalEntityId: leB.id,
    });
    const list = await createTestPriceList(ctxAB, leA.id);
    await createPriceListAssignment(ctxAB, {
      priceListId: list.priceList.id,
      legalEntityId: leB.id,
    });
    await setDefaultPriceList(ctxAB, {
      legalEntityId: leA.id,
      priceListId: list.priceList.id,
    });
    const created = await invoke(
      entriesPost,
      request(`${base}/pricing/price-list-entries`, {
        method: "POST",
        json: {
          priceListAssignmentId: list.assignment.id,
          catalogItemAssignmentId: item.assignment.id,
          unitPrice: "7.5",
          effectiveFrom: "2026-07-01",
          effectiveTo: "2026-07-31",
        },
      }),
      { tenantId },
    );
    expect(created.status).toBe(201);
    const entry = (
      (await readJson(created)).data as { entry: { id: string; unitPrice: string } }
    ).entry;

    const missingDate = await invoke(
      resolveGet,
      request(
        `${base}/pricing/effective-price?legalEntityId=${leA.id}&catalogItemId=${item.item.id}`,
      ),
      { tenantId },
    );
    expect(missingDate.status).toBe(422);

    const resolved = await invoke(
      resolveGet,
      request(
        `${base}/pricing/effective-price?legalEntityId=${leA.id}&catalogItemId=${item.item.id}&onDate=2026-07-01`,
      ),
      { tenantId },
    );
    expect(resolved.status).toBe(200);
    const resolvedBody = await readJson(resolved);
    assertMatchesOpenApi("resolveEffectivePrice", resolvedBody, ["price"]);
    const hit = (
      resolvedBody.data as {
        price: {
          resolved: boolean;
          unitPrice: string | null;
          entryId: string | null;
          effectiveFrom: string | null;
          onDate: string;
        };
      }
    ).price;
    expect(hit.resolved).toBe(true);
    expect(hit.unitPrice).toBe("7.500000");
    expect(hit.entryId).toBe(entry.id);
    expect(hit.effectiveFrom).toBe("2026-07-01");
    expect(hit.onDate).toBe("2026-07-01");

    const lastDay = await invoke(
      resolveGet,
      request(
        `${base}/pricing/effective-price?legalEntityId=${leA.id}&catalogItemId=${item.item.id}&onDate=2026-07-31`,
      ),
      { tenantId },
    );
    expect(
      ((await readJson(lastDay)).data as { price: { resolved: boolean } }).price.resolved,
    ).toBe(true);

    const openEnded = await invoke(
      entriesPost,
      request(`${base}/pricing/price-list-entries`, {
        method: "POST",
        json: {
          priceListAssignmentId: list.assignment.id,
          catalogItemAssignmentId: item.assignment.id,
          unitPrice: "8",
          effectiveFrom: "2026-08-01",
          effectiveTo: null,
        },
      }),
      { tenantId },
    );
    expect(openEnded.status).toBe(201);
    const beforeBuckets = await writeBucketCounts(tenantId, userId);
    const beforeAudits = await withTenantContext(
      { tenantId, legalEntityIds: ctxAB.legalEntityIds },
      (tx) => tx.auditEvent.count({ where: { tenantId } }),
    );
    const future = await invoke(
      resolveGet,
      request(
        `${base}/pricing/effective-price?legalEntityId=${leA.id}&catalogItemId=${item.item.id}&onDate=2027-01-01`,
      ),
      { tenantId },
    );
    expect(
      (
        (await readJson(future)).data as {
          price: { resolved: boolean; unitPrice: string | null };
        }
      ).price.unitPrice,
    ).toBe("8.000000");

    const gap = await invoke(
      resolveGet,
      request(
        `${base}/pricing/effective-price?legalEntityId=${leA.id}&catalogItemId=${item.item.id}&onDate=2026-06-30`,
      ),
      { tenantId },
    );
    expect(gap.status).toBe(200);
    const gapBody = await readJson(gap);
    assertMatchesOpenApi("resolveEffectivePrice", gapBody, ["price"]);
    const miss = (gapBody.data as { price: { resolved: boolean; unitPrice: null } })
      .price;
    expect(miss.resolved).toBe(false);
    expect(miss.unitPrice).toBeNull();

    const schema = OPENAPI_DOC.components?.schemas?.EffectivePrice as OpenApiSchema;
    const brokenResolved: OpenApiSchema = {
      ...schema,
      properties: {
        ...schema.properties,
        resolved: { type: "boolean", enum: [true] },
      },
    };
    expect(
      validateOpenApiValue(
        OPENAPI_DOC,
        brokenResolved,
        miss,
        "broken-unresolved-shape",
      ).some((error) => error.includes("enum")),
    ).toBe(true);

    expect(await writeBucketCounts(tenantId, userId)).toEqual(beforeBuckets);
    expect(
      await withTenantContext({ tenantId, legalEntityIds: ctxAB.legalEntityIds }, (tx) =>
        tx.auditEvent.count({ where: { tenantId } }),
      ),
    ).toBe(beforeAudits);

    const noDefault = await invoke(
      resolveGet,
      request(
        `${base}/pricing/effective-price?legalEntityId=${leB.id}&catalogItemId=${item.item.id}&onDate=2026-07-15`,
      ),
      { tenantId },
    );
    expect(noDefault.status).toBe(404);
    expect(errorCode(await readJson(noDefault))).toBe("NOT_FOUND");

    await updatePriceListAssignment(ctxAB, list.assignment.id, {
      expectedVersion: list.assignment.version + 1,
      status: "SUSPENDED",
    });
    const inactiveAssign = await invoke(
      resolveGet,
      request(
        `${base}/pricing/effective-price?legalEntityId=${leA.id}&catalogItemId=${item.item.id}&onDate=2026-07-15&priceListId=${list.priceList.id}`,
      ),
      { tenantId },
    );
    expect(inactiveAssign.status).toBe(404);

    await updatePriceListAssignment(ctxAB, list.assignment.id, {
      expectedVersion: list.assignment.version + 2,
      status: "ACTIVE",
    });
    await updateCatalogItemAssignment(ctxAB, item.assignment.id, {
      expectedVersion: item.assignment.version,
      status: "SUSPENDED",
    });
    const inactiveItem = await invoke(
      resolveGet,
      request(
        `${base}/pricing/effective-price?legalEntityId=${leA.id}&catalogItemId=${item.item.id}&onDate=2026-07-15&priceListId=${list.priceList.id}`,
      ),
      { tenantId },
    );
    expect(inactiveItem.status).toBe(404);
  }, 90_000);
});
