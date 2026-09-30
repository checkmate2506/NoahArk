import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { POST as entriesPost } from "@/app/api/v1/tenants/[tenantId]/pricing/price-list-entries/route";
import { GET as resolveGet } from "@/app/api/v1/tenants/[tenantId]/pricing/effective-price/route";
import { cleanupTenant, cleanupUser, uniqueSlug } from "./testHelpers";
import {
  catalogCode,
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

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRICING_ROUTE_ROOT = join(WEB_ROOT, "app/api/v1/tenants/[tenantId]/pricing");

function collectRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectRouteFiles(full));
    } else if (name === "route.ts") {
      out.push(full);
    }
  }
  return out;
}

describe("P2D.3b pricing price-list and assignment APIs", () => {
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

  it("enforces pricing route and OpenAPI structural contracts", () => {
    const routes = collectRouteFiles(PRICING_ROUTE_ROOT);
    expect(routes).toHaveLength(11);
    const combined = [
      ...routes.map((file) => readFileSync(file, "utf8")),
      readFileSync(join(WEB_ROOT, "lib/api/schemas/pricingSchemas.ts"), "utf8"),
      readFileSync(join(WEB_ROOT, "lib/services/catalogDomain.ts"), "utf8"),
    ].join("\n");
    const banned = [
      "23P01",
      "23505",
      "42501",
      "P2002",
      "P2025",
      "sqlState",
      "originalCode",
      "driverAdapterError",
      "$transaction",
      "createSystemClient",
      "createWorkerClient",
      "@noahark/db/system",
      "@noahark/db/worker",
      "tenantReadPostRoute",
      "catalog-item-assignments:",
      "PRICE_LIST_ARCHIVED",
      "discount",
      "promotion",
      "taxInclusive",
      "currencyConversion",
      "exchangeRate",
      "roundingMode",
      "parseFloat",
    ];
    for (const token of banned) {
      expect(combined, token).not.toContain(token);
    }
    expect(combined).not.toMatch(/\barchivePriceList\b/);
    expect(combined).not.toMatch(/\bexport const DELETE\b/);
    expect(combined).not.toMatch(/\bapiHandler\s*\(/);
    expect(combined).not.toMatch(/\bauthorize\s*\(/);

    const yaml = readFileSync(join(WEB_ROOT, "openapi.yaml"), "utf8");
    expect(yaml).not.toMatch(/\barchivePriceList\b/);
    expect(yaml).not.toContain("price_list:archive");
    expect(yaml).not.toMatch(/\/pricing\/price-lists\/\{priceListId\}\/archive/);
    expect(yaml).not.toMatch(
      /operationId: (create|update|close|list|get|resolve).*[\s\S]{0,200}unitPrice:[\s\S]{0,80}type: number/,
    );

    const walk = (schema: OpenApiSchema | undefined, path: string) => {
      if (!schema) return;
      if (
        path.toLowerCase().includes("unitprice") ||
        path.toLowerCase().includes("amount")
      ) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        expect(types, path).not.toContain("number");
        expect(types, path).not.toContain("integer");
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        walk(child, `${path}.${key}`);
      }
      if (schema.items) walk(schema.items, `${path}[]`);
    };
    walk(OPENAPI_DOC.components?.schemas?.PriceListEntry, "PriceListEntry");
    walk(OPENAPI_DOC.components?.schemas?.EffectivePrice, "EffectivePrice");

    const entrySchema = OPENAPI_DOC.components?.schemas?.PriceListEntry;
    expect(
      validateOpenApiValue(
        OPENAPI_DOC,
        {
          ...entrySchema!,
          properties: { ...entrySchema!.properties, unitPrice: { type: "number" } },
        },
        {
          id: "e1",
          legalEntityId: "le",
          priceListAssignmentId: "pa",
          catalogItemAssignmentId: "ca",
          unitPrice: "1.000000",
          effectiveFrom: "2026-07-01",
          effectiveTo: null,
          version: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        "broken-numeric-unitPrice",
      ).some((error) => error.includes("type")),
    ).toBe(true);

    const assignmentSchema = OPENAPI_DOC.components?.schemas?.PriceListAssignment;
    expect(
      validateOpenApiValue(
        OPENAPI_DOC,
        {
          ...assignmentSchema!,
          properties: {
            ...assignmentSchema!.properties,
            status: { type: "string", enum: ["ACTIVE"] },
          },
        },
        {
          id: "a1",
          priceListId: "p1",
          legalEntityId: "le",
          isDefault: false,
          status: "ARCHIVED",
          assignedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: "2026-01-01T00:00:00.000Z",
          version: 2,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        "broken-assignment-status",
      ).some((error) => error.includes("enum")),
    ).toBe(true);

    const effectiveSchema = OPENAPI_DOC.components?.schemas?.EffectivePrice;
    expect(
      validateOpenApiValue(
        OPENAPI_DOC,
        {
          ...effectiveSchema!,
          properties: {
            ...effectiveSchema!.properties,
            unitPrice: { type: "string" },
          },
        },
        {
          resolved: false,
          unitPrice: null,
          currency: "SGD",
          priceListId: "p1",
          priceListAssignmentId: "pa",
          catalogItemAssignmentId: "ca",
          legalEntityId: "le",
          onDate: "2026-07-15",
          entryId: null,
          effectiveFrom: null,
          effectiveTo: null,
        },
        "broken-missing-null-unitPrice",
      ).some((error) => error.includes("type")),
    ).toBe(true);
    expect(
      validateOpenApiValue(
        OPENAPI_DOC,
        {
          ...effectiveSchema!,
          properties: {
            ...effectiveSchema!.properties,
            onDate: { type: "string", format: "date-time" } as unknown as OpenApiSchema,
          },
        },
        {
          resolved: true,
          unitPrice: "1.000000",
          currency: "SGD",
          priceListId: "p1",
          priceListAssignmentId: "pa",
          catalogItemAssignmentId: "ca",
          legalEntityId: "le",
          onDate: "2026-07-15",
          entryId: "e1",
          effectiveFrom: "2026-07-01",
          effectiveTo: "2026-07-31",
        },
        "civil-date-as-datetime-doc",
      ),
    ).toEqual([]);
    expect(
      (effectiveSchema?.properties?.onDate as { format?: string } | undefined)?.format,
    ).toBe("date");
    expect(
      (effectiveSchema?.properties?.onDate as { format?: string } | undefined)?.format,
    ).not.toBe("date-time");
    expect(
      (entrySchema?.properties?.effectiveFrom as { format?: string } | undefined)?.format,
    ).toBe("date");
  });

  it("covers price-list CRUD, assignment lifecycle, audit, CSRF and OpenAPI", async () => {
    fixture = await setupPricingDomainFixture();
    const { setup, ctxAB, leA, leB, leC } = fixture;
    const tenantId = setup.tenantId;
    const userId = setup.adminUserId;
    pricingApiAuth.userId = userId;
    const pgVersion = (
      await createSystemClient().$queryRaw<Array<{ version: string }>>`SELECT version()`
    )[0]?.version;
    expect(pgVersion).toMatch(/^PostgreSQL 18\.4\b/);
    console.warn(`[P2D.3b] SELECT version(): ${pgVersion}`);
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const code = catalogCode("PL");
    const createRequestId = uniqueSlug("rid");
    const beforeBuckets = await writeBucketCounts(tenantId, userId);

    const createdRes = await invoke(
      listsPost,
      request(`${base}/pricing/price-lists`, {
        method: "POST",
        headers: { "x-request-id": createRequestId },
        json: {
          ownerLegalEntityId: leA.id,
          code,
          name: "Retail SGD",
          currency: "SGD",
          actingUserId: "forged",
        },
      }),
      { tenantId },
    );
    expect(createdRes.status).toBe(201);
    const createdBody = await readJson(createdRes);
    assertMatchesOpenApi("createPriceList", createdBody, ["priceList", "assignment"]);
    const created = createdBody.data as {
      priceList: {
        id: string;
        version: number;
        currency: string;
        ownerLegalEntityId: string;
        code: string;
      };
      assignment: {
        id: string;
        version: number;
        legalEntityId: string;
        isDefault: boolean;
      };
    };
    expect(created.priceList.currency).toBe("SGD");
    expect(created.priceList.ownerLegalEntityId).toBe(leA.id);
    expect(created.assignment.legalEntityId).toBe(leA.id);
    expect(created.assignment.isDefault).toBe(false);
    expect(await writeBucketCounts(tenantId, userId)).toEqual({
      user: beforeBuckets.user + 1,
      tenant: beforeBuckets.tenant + 1,
    });

    const listed = await invoke(listsGet, request(`${base}/pricing/price-lists`), {
      tenantId,
    });
    expect(listed.status).toBe(200);
    const listedBody = await readJson(listed);
    assertMatchesOpenApi("listPriceLists", listedBody, ["priceLists", "nextCursor"]);

    const got = await invoke(
      listGet,
      request(`${base}/pricing/price-lists/${created.priceList.id}`),
      { tenantId, priceListId: created.priceList.id },
    );
    expect(got.status).toBe(200);
    assertMatchesOpenApi("getPriceList", await readJson(got), ["priceList"]);

    const updated = await invoke(
      listPatch,
      request(`${base}/pricing/price-lists/${created.priceList.id}`, {
        method: "PATCH",
        json: { expectedVersion: created.priceList.version, name: "Retail SGD renamed" },
      }),
      { tenantId, priceListId: created.priceList.id },
    );
    expect(updated.status).toBe(200);
    const updatedBody = await readJson(updated);
    assertMatchesOpenApi("updatePriceList", updatedBody, ["priceList"]);
    const afterUpdate = (
      updatedBody.data as { priceList: { version: number; currency: string } }
    ).priceList;
    expect(afterUpdate.version).toBe(created.priceList.version + 1);
    expect(afterUpdate.currency).toBe("SGD");

    expect(
      (
        await invoke(
          listPatch,
          request(`${base}/pricing/price-lists/${created.priceList.id}`, {
            method: "PATCH",
            json: { expectedVersion: afterUpdate.version, currency: "MYR" },
          }),
          { tenantId, priceListId: created.priceList.id },
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await invoke(
          listPatch,
          request(`${base}/pricing/price-lists/${created.priceList.id}`, {
            method: "PATCH",
            json: { expectedVersion: afterUpdate.version, ownerLegalEntityId: leB.id },
          }),
          { tenantId, priceListId: created.priceList.id },
        )
      ).status,
    ).toBe(422);

    const extraAssign = await invoke(
      assignmentsPost,
      request(`${base}/pricing/price-list-assignments`, {
        method: "POST",
        json: { priceListId: created.priceList.id, legalEntityId: leB.id },
      }),
      { tenantId },
    );
    expect(extraAssign.status).toBe(201);
    const extraAssignBody = await readJson(extraAssign);
    assertMatchesOpenApi("createPriceListAssignment", extraAssignBody, ["assignment"]);
    const extra = (
      extraAssignBody.data as {
        assignment: { id: string; version: number; status: string };
      }
    ).assignment;

    const listedAssign = await invoke(
      assignmentsGet,
      request(
        `${base}/pricing/price-list-assignments?priceListId=${created.priceList.id}`,
      ),
      { tenantId },
    );
    expect(listedAssign.status).toBe(200);
    assertMatchesOpenApi("listPriceListAssignments", await readJson(listedAssign), [
      "assignments",
      "nextCursor",
    ]);

    const gotAssign = await invoke(
      assignmentGet,
      request(`${base}/pricing/price-list-assignments/${extra.id}`),
      { tenantId, assignmentId: extra.id },
    );
    expect(gotAssign.status).toBe(200);
    assertMatchesOpenApi("getPriceListAssignment", await readJson(gotAssign), [
      "assignment",
    ]);

    const suspended = await invoke(
      assignmentPatch,
      request(`${base}/pricing/price-list-assignments/${extra.id}`, {
        method: "PATCH",
        json: { expectedVersion: extra.version, status: "SUSPENDED" },
      }),
      { tenantId, assignmentId: extra.id },
    );
    expect(suspended.status).toBe(200);
    const suspendedBody = await readJson(suspended);
    assertMatchesOpenApi("updatePriceListAssignment", suspendedBody, ["assignment"]);
    expect(
      (suspendedBody.data as { assignment: { isDefault: boolean; status: string } })
        .assignment.status,
    ).toBe("SUSPENDED");

    const reactivated = await invoke(
      assignmentPatch,
      request(`${base}/pricing/price-list-assignments/${extra.id}`, {
        method: "PATCH",
        json: {
          expectedVersion: (suspendedBody.data as { assignment: { version: number } })
            .assignment.version,
          status: "ACTIVE",
        },
      }),
      { tenantId, assignmentId: extra.id },
    );
    expect(reactivated.status).toBe(200);
    const extraActive = (
      (await readJson(reactivated)).data as {
        assignment: { id: string; version: number };
      }
    ).assignment;

    const archivedOwner = await invoke(
      assignmentArchive,
      request(`${base}/pricing/price-list-assignments/${created.assignment.id}/archive`, {
        method: "POST",
        json: { expectedVersion: created.assignment.version },
      }),
      { tenantId, assignmentId: created.assignment.id },
    );
    expect(archivedOwner.status).toBe(200);

    const lastRemain = await invoke(
      assignmentArchive,
      request(`${base}/pricing/price-list-assignments/${extraActive.id}/archive`, {
        method: "POST",
        json: { expectedVersion: extraActive.version },
      }),
      { tenantId, assignmentId: extraActive.id },
    );
    expect(lastRemain.status).toBe(409);
    expect(errorCode(await readJson(lastRemain))).toBe("CONFLICT");

    const third = await invoke(
      assignmentsPost,
      request(`${base}/pricing/price-list-assignments`, {
        method: "POST",
        json: { priceListId: created.priceList.id, legalEntityId: leC.id },
      }),
      { tenantId },
    );
    expect(third.status).toBe(201);
    const thirdAssign = (
      (await readJson(third)).data as { assignment: { id: string; version: number } }
    ).assignment;
    const archived = await invoke(
      assignmentArchive,
      request(`${base}/pricing/price-list-assignments/${thirdAssign.id}/archive`, {
        method: "POST",
        json: { expectedVersion: thirdAssign.version },
      }),
      { tenantId, assignmentId: thirdAssign.id },
    );
    expect(archived.status).toBe(200);
    const archivedBody = await readJson(archived);
    assertMatchesOpenApi("archivePriceListAssignment", archivedBody, ["assignment"]);
    expect(
      (archivedBody.data as { assignment: { status: string; isDefault: boolean } })
        .assignment.status,
    ).toBe("ARCHIVED");

    const recreate = await invoke(
      assignmentsPost,
      request(`${base}/pricing/price-list-assignments`, {
        method: "POST",
        json: { priceListId: created.priceList.id, legalEntityId: leC.id },
      }),
      { tenantId },
    );
    expect(recreate.status).toBe(409);

    const transferred = await invoke(
      listTransfer,
      request(`${base}/pricing/price-lists/${created.priceList.id}/ownership-transfer`, {
        method: "POST",
        json: {
          newOwnerLegalEntityId: leB.id,
          expectedVersion: afterUpdate.version,
        },
      }),
      { tenantId, priceListId: created.priceList.id },
    );
    expect(transferred.status).toBe(200);
    const transferBody = await readJson(transferred);
    assertMatchesOpenApi("transferPriceListOwnership", transferBody, ["priceList"]);
    expect(
      (transferBody.data as { priceList: { ownerLegalEntityId: string } }).priceList
        .ownerLegalEntityId,
    ).toBe(leB.id);

    expect(
      (
        await invoke(listsGet, request(`${base}/pricing/price-lists?unknown=1`), {
          tenantId,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await invoke(listsGet, request(`${base}/pricing/price-lists?limit=1&limit=2`), {
          tenantId,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await invoke(listsGet, request(`${base}/pricing/price-lists?limit=0`), {
          tenantId,
        })
      ).status,
    ).toBe(422);

    const uom = await createTestUom(ctxAB);
    const item = await createTestItem(ctxAB, leB.id, uom.id);
    const currentAssign = await withTenantContext(
      { tenantId, legalEntityIds: ctxAB.legalEntityIds },
      (tx) =>
        tx.priceListLegalEntityAssignment.findFirstOrThrow({
          where: { priceListId: created.priceList.id, legalEntityId: leB.id },
        }),
    );
    const entryCreated = await invoke(
      entriesPost,
      request(`${base}/pricing/price-list-entries`, {
        method: "POST",
        json: {
          priceListAssignmentId: currentAssign.id,
          catalogItemAssignmentId: item.assignment.id,
          unitPrice: "1.5",
          effectiveFrom: "2026-07-01",
          effectiveTo: null,
        },
      }),
      { tenantId },
    );
    expect(entryCreated.status).toBe(201);
    const entry = (
      (await readJson(entryCreated)).data as { entry: { unitPrice: string } }
    ).entry;
    expect(entry.unitPrice).toBe("1.500000");
    expect(typeof entry.unitPrice).toBe("string");

    for (const bad of ["-1", "1e2", "1,00", "01", "1.0000001", 1]) {
      const rejected = await invoke(
        entriesPost,
        request(`${base}/pricing/price-list-entries`, {
          method: "POST",
          json: {
            priceListAssignmentId: currentAssign.id,
            catalogItemAssignmentId: item.assignment.id,
            unitPrice: bad,
            effectiveFrom: "2026-08-01",
            effectiveTo: "2026-08-31",
          },
        }),
        { tenantId },
      );
      expect(rejected.status, String(bad)).toBe(422);
    }

    for (let i = 0; i < 26; i += 1) {
      await createTestPriceList(ctxAB, leA.id, "SGD", `Page ${i}`);
    }
    const page1 = await invoke(
      listsGet,
      request(`${base}/pricing/price-lists?limit=25`),
      { tenantId },
    );
    const page1Body = (await readJson(page1)).data as {
      priceLists: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(page1Body.priceLists).toHaveLength(25);
    expect(page1Body.nextCursor).toBeTruthy();
    const capped = await invoke(
      listsGet,
      request(`${base}/pricing/price-lists?limit=1000`),
      { tenantId },
    );
    expect(
      ((await readJson(capped)).data as { priceLists: unknown[] }).priceLists.length,
    ).toBeLessThanOrEqual(100);

    const resolveMissing = await invoke(
      resolveGet,
      request(
        `${base}/pricing/effective-price?legalEntityId=${leB.id}&catalogItemId=${item.item.id}`,
      ),
      { tenantId },
    );
    expect(resolveMissing.status).toBe(422);

    const csrfBefore = await writeBucketCounts(tenantId, userId);
    const csrfState = await withTenantContext(
      { tenantId, legalEntityIds: ctxAB.legalEntityIds },
      async (tx) => ({
        lists: await tx.priceList.count({ where: { tenantId } }),
        assignments: await tx.priceListLegalEntityAssignment.count({
          where: { tenantId },
        }),
        audits: await tx.auditEvent.count({ where: { tenantId } }),
      }),
    );
    const csrfCreate = await invoke(
      listsPost,
      request(`${base}/pricing/price-lists`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        json: {
          ownerLegalEntityId: leA.id,
          code: catalogCode("PL"),
          name: "CSRF",
          currency: "SGD",
        },
      }),
      { tenantId },
    );
    const csrfTransfer = await invoke(
      listTransfer,
      request(`${base}/pricing/price-lists/${created.priceList.id}/ownership-transfer`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        json: {
          newOwnerLegalEntityId: leA.id,
          expectedVersion: 99,
        },
      }),
      { tenantId, priceListId: created.priceList.id },
    );
    const csrfArchive = await invoke(
      assignmentArchive,
      request(`${base}/pricing/price-list-assignments/${extraActive.id}/archive`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        json: { expectedVersion: extraActive.version },
      }),
      { tenantId, assignmentId: extraActive.id },
    );
    expect(csrfCreate.status).toBe(403);
    expect(csrfTransfer.status).toBe(403);
    expect(csrfArchive.status).toBe(403);
    expect(await writeBucketCounts(tenantId, userId)).toEqual(csrfBefore);
    expect(
      await withTenantContext(
        { tenantId, legalEntityIds: ctxAB.legalEntityIds },
        async (tx) => ({
          lists: await tx.priceList.count({ where: { tenantId } }),
          assignments: await tx.priceListLegalEntityAssignment.count({
            where: { tenantId },
          }),
          audits: await tx.auditEvent.count({ where: { tenantId } }),
        }),
      ),
    ).toEqual(csrfState);

    const events = await withTenantContext(
      { tenantId, legalEntityIds: ctxAB.legalEntityIds },
      (tx) =>
        tx.auditEvent.findMany({
          where: { tenantId },
          orderBy: { sequence: "asc" },
        }),
    );
    expect(verifyAuditChain(toLinks(events)).valid).toBe(true);
    expect(events.some((row) => row.action === AUDIT_ACTIONS.PRICE_LIST_CREATED)).toBe(
      true,
    );
    expect(events.some((row) => row.actorUserId === userId)).toBe(true);
    expect(events.some((row) => row.requestId === createRequestId)).toBe(true);
    expect(JSON.stringify(events.map((row) => row.afterData))).not.toMatch(/23P01/);
  }, 180_000);
});
