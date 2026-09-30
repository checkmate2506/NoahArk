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
import { PUT as setDefault } from "@/app/api/v1/tenants/[tenantId]/pricing/default-price-list/route";
import { cleanupTenant, cleanupUser, uniqueSlug } from "./testHelpers";
import {
  createTestPriceList,
  setupPricingDomainFixture,
  type PricingDomainFixture,
} from "./pricingDomainFixture";
import { assertMatchesOpenApi } from "./openapiResponseValidator";

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

describe("P2D.3b default price list API", () => {
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

  it("sets, swaps, clears, rejects no-ops, and forges Origin without writes", async () => {
    fixture = await setupPricingDomainFixture();
    const { setup, ctxAB, leA } = fixture;
    const tenantId = setup.tenantId;
    const userId = setup.adminUserId;
    pricingApiAuth.userId = userId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const first = await createTestPriceList(ctxAB, leA.id, "SGD", "First");
    const second = await createTestPriceList(ctxAB, leA.id, "SGD", "Second");
    const db = createSystemClient();

    const clearNone = await invoke(
      setDefault,
      request(`${base}/pricing/default-price-list`, {
        method: "PUT",
        json: { legalEntityId: leA.id, priceListId: null },
      }),
      { tenantId },
    );
    expect(clearNone.status).toBe(422);
    expect(errorCode(await readJson(clearNone))).toBe("VALIDATION_FAILED");
    expect(
      await db.auditEvent.count({
        where: { tenantId, action: AUDIT_ACTIONS.PRICE_LIST_DEFAULT_CHANGED },
      }),
    ).toBe(0);

    const firstVersion = (
      await db.priceListLegalEntityAssignment.findFirstOrThrow({
        where: { id: first.assignment.id },
      })
    ).version;
    const setFirst = await invoke(
      setDefault,
      request(`${base}/pricing/default-price-list`, {
        method: "PUT",
        json: { legalEntityId: leA.id, priceListId: first.priceList.id },
      }),
      { tenantId },
    );
    expect(setFirst.status).toBe(200);
    const setBody = await readJson(setFirst);
    assertMatchesOpenApi("setDefaultPriceList", setBody, ["selection"]);
    const selection = (
      setBody.data as {
        selection: {
          legalEntityId: string;
          previousPriceListId: string | null;
          priceListId: string | null;
        };
      }
    ).selection;
    expect(selection.priceListId).toBe(first.priceList.id);
    expect(selection.previousPriceListId).toBeNull();
    const afterFirst = await db.priceListLegalEntityAssignment.findFirstOrThrow({
      where: { id: first.assignment.id },
    });
    expect(afterFirst.isDefault).toBe(true);
    expect(afterFirst.version).toBe(firstVersion + 1);
    expect(
      await db.auditEvent.count({
        where: { tenantId, action: AUDIT_ACTIONS.PRICE_LIST_DEFAULT_CHANGED },
      }),
    ).toBe(1);

    const noOpAudits = await db.auditEvent.count({ where: { tenantId } });
    const already = await invoke(
      setDefault,
      request(`${base}/pricing/default-price-list`, {
        method: "PUT",
        json: { legalEntityId: leA.id, priceListId: first.priceList.id },
      }),
      { tenantId },
    );
    expect(already.status).toBe(422);
    expect(
      (
        await db.priceListLegalEntityAssignment.findFirstOrThrow({
          where: { id: first.assignment.id },
        })
      ).version,
    ).toBe(afterFirst.version);
    expect(await db.auditEvent.count({ where: { tenantId } })).toBe(noOpAudits);

    const beforeSwapSecond = await db.priceListLegalEntityAssignment.findFirstOrThrow({
      where: { id: second.assignment.id },
    });
    const swap = await invoke(
      setDefault,
      request(`${base}/pricing/default-price-list`, {
        method: "PUT",
        json: { legalEntityId: leA.id, priceListId: second.priceList.id },
      }),
      { tenantId },
    );
    expect(swap.status).toBe(200);
    const swapSel = (
      (await readJson(swap)).data as {
        selection: { previousPriceListId: string | null; priceListId: string | null };
      }
    ).selection;
    expect(swapSel.previousPriceListId).toBe(first.priceList.id);
    expect(swapSel.priceListId).toBe(second.priceList.id);
    const afterSwapFirst = await db.priceListLegalEntityAssignment.findFirstOrThrow({
      where: { id: first.assignment.id },
    });
    const afterSwapSecond = await db.priceListLegalEntityAssignment.findFirstOrThrow({
      where: { id: second.assignment.id },
    });
    expect(afterSwapFirst.isDefault).toBe(false);
    expect(afterSwapSecond.isDefault).toBe(true);
    expect(afterSwapFirst.version).toBe(afterFirst.version + 1);
    expect(afterSwapSecond.version).toBe(beforeSwapSecond.version + 1);
    expect(
      await db.auditEvent.count({
        where: { tenantId, action: AUDIT_ACTIONS.PRICE_LIST_DEFAULT_CHANGED },
      }),
    ).toBe(2);

    const cleared = await invoke(
      setDefault,
      request(`${base}/pricing/default-price-list`, {
        method: "PUT",
        json: { legalEntityId: leA.id, priceListId: null },
      }),
      { tenantId },
    );
    expect(cleared.status).toBe(200);
    expect(
      (
        (await readJson(cleared)).data as {
          selection: { priceListId: string | null };
        }
      ).selection.priceListId,
    ).toBeNull();
    expect(
      (
        await db.priceListLegalEntityAssignment.findFirstOrThrow({
          where: { id: second.assignment.id },
        })
      ).isDefault,
    ).toBe(false);
    expect(
      await db.auditEvent.count({
        where: { tenantId, action: AUDIT_ACTIONS.PRICE_LIST_DEFAULT_CHANGED },
      }),
    ).toBe(3);

    const csrfBefore = await writeBucketCounts(tenantId, userId);
    const csrfState = await withTenantContext(
      { tenantId, legalEntityIds: ctxAB.legalEntityIds },
      async (tx) => ({
        defaults: await tx.priceListLegalEntityAssignment.count({
          where: { tenantId, isDefault: true },
        }),
        audits: await tx.auditEvent.count({ where: { tenantId } }),
      }),
    );
    const csrf = await invoke(
      setDefault,
      request(`${base}/pricing/default-price-list`, {
        method: "PUT",
        headers: { Origin: "https://evil.example" },
        json: { legalEntityId: leA.id, priceListId: first.priceList.id },
      }),
      { tenantId },
    );
    expect(csrf.status).toBe(403);
    expect(await writeBucketCounts(tenantId, userId)).toEqual(csrfBefore);
    expect(
      await withTenantContext(
        { tenantId, legalEntityIds: ctxAB.legalEntityIds },
        async (tx) => ({
          defaults: await tx.priceListLegalEntityAssignment.count({
            where: { tenantId, isDefault: true },
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
  }, 90_000);
});
