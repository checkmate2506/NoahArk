import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { AUDIT_ACTIONS, verifyAuditChain } from "@noahark/audit";
import { withTenantContext } from "@noahark/db";
import {
  createCatalogItemAssignment,
  createPriceListAssignment,
  createPriceListEntry,
  updateCatalogItemAssignment,
  updatePriceListAssignment,
} from "@/lib/services/catalogDomain";
import {
  API_WRITE_TENANT,
  API_WRITE_TENANT_USER,
  apiWriteCanonicalKey,
  hashKey,
} from "@/lib/rateLimiter";
import { createSystemClient } from "@noahark/db/system";
import {
  GET as entriesGet,
  POST as entriesPost,
} from "@/app/api/v1/tenants/[tenantId]/pricing/price-list-entries/route";
import {
  GET as entryGet,
  PATCH as entryPatch,
} from "@/app/api/v1/tenants/[tenantId]/pricing/price-list-entries/[entryId]/route";
import { POST as entryClose } from "@/app/api/v1/tenants/[tenantId]/pricing/price-list-entries/[entryId]/close/route";
import { cleanupTenant, cleanupUser, uniqueSlug } from "./testHelpers";
import {
  createTestItem,
  createTestPriceList,
  createTestUom,
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

describe("P2D.3b price list entry APIs", () => {
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

  it("creates, lists, updates, closes, rejects overlap, and forges Origin", async () => {
    fixture = await setupPricingDomainFixture();
    const { setup, ctxAB, leA, leB } = fixture;
    const tenantId = setup.tenantId;
    const userId = setup.adminUserId;
    pricingApiAuth.userId = userId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const uom = await createTestUom(ctxAB);
    const item = await createTestItem(ctxAB, leA.id, uom.id);
    const list = await createTestPriceList(ctxAB, leA.id);
    await createPriceListAssignment(ctxAB, {
      priceListId: list.priceList.id,
      legalEntityId: leB.id,
    });
    const itemB = await createCatalogItemAssignment(ctxAB, {
      catalogItemId: item.item.id,
      legalEntityId: leB.id,
    });

    const created = await invoke(
      entriesPost,
      request(`${base}/pricing/price-list-entries`, {
        method: "POST",
        json: {
          priceListAssignmentId: list.assignment.id,
          catalogItemAssignmentId: item.assignment.id,
          unitPrice: "10",
          effectiveFrom: "2026-07-01",
          effectiveTo: "2026-07-31",
        },
      }),
      { tenantId },
    );
    expect(created.status).toBe(201);
    const createdBody = await readJson(created);
    assertMatchesOpenApi("createPriceListEntry", createdBody, ["entry"]);
    const entry = (
      createdBody.data as {
        entry: {
          id: string;
          version: number;
          unitPrice: string;
          effectiveFrom: string;
          effectiveTo: string | null;
          legalEntityId: string;
        };
      }
    ).entry;
    expect(entry.unitPrice).toBe("10.000000");
    expect(entry.effectiveFrom).toBe("2026-07-01");
    expect(entry.effectiveTo).toBe("2026-07-31");
    expect(entry.legalEntityId).toBe(leA.id);

    const listed = await invoke(
      entriesGet,
      request(`${base}/pricing/price-list-entries`),
      {
        tenantId,
      },
    );
    expect(listed.status).toBe(200);
    assertMatchesOpenApi("listPriceListEntries", await readJson(listed), [
      "entries",
      "nextCursor",
    ]);

    const got = await invoke(
      entryGet,
      request(`${base}/pricing/price-list-entries/${entry.id}`),
      { tenantId, entryId: entry.id },
    );
    expect(got.status).toBe(200);
    assertMatchesOpenApi("getPriceListEntry", await readJson(got), ["entry"]);

    const adjacent = await invoke(
      entriesPost,
      request(`${base}/pricing/price-list-entries`, {
        method: "POST",
        json: {
          priceListAssignmentId: list.assignment.id,
          catalogItemAssignmentId: item.assignment.id,
          unitPrice: "11",
          effectiveFrom: "2026-08-01",
          effectiveTo: "2026-08-01",
        },
      }),
      { tenantId },
    );
    expect(adjacent.status).toBe(201);
    const adjacentEntry = (
      (await readJson(adjacent)).data as {
        entry: { id: string; version: number; effectiveTo: string | null };
      }
    ).entry;
    expect(adjacentEntry.effectiveTo).toBe("2026-08-01");

    const overlap = await invoke(
      entriesPost,
      request(`${base}/pricing/price-list-entries`, {
        method: "POST",
        json: {
          priceListAssignmentId: list.assignment.id,
          catalogItemAssignmentId: item.assignment.id,
          unitPrice: "12",
          effectiveFrom: "2026-07-15",
          effectiveTo: "2026-07-20",
        },
      }),
      { tenantId },
    );
    expect(overlap.status).toBe(409);
    const overlapBody = await readJson(overlap);
    expect(errorCode(overlapBody)).toBe("CONFLICT");
    expect(JSON.stringify(overlapBody)).not.toMatch(/23P01|prisma|exclusion|pg_/i);

    const mismatched = await invoke(
      entriesPost,
      request(`${base}/pricing/price-list-entries`, {
        method: "POST",
        json: {
          priceListAssignmentId: list.assignment.id,
          catalogItemAssignmentId: itemB.id,
          unitPrice: "1",
          effectiveFrom: "2026-09-01",
          effectiveTo: null,
        },
      }),
      { tenantId },
    );
    expect(mismatched.status).toBe(422);

    const updated = await invoke(
      entryPatch,
      request(`${base}/pricing/price-list-entries/${entry.id}`, {
        method: "PATCH",
        json: { expectedVersion: entry.version, unitPrice: "10.5" },
      }),
      { tenantId, entryId: entry.id },
    );
    expect(updated.status).toBe(200);
    const updatedBody = await readJson(updated);
    assertMatchesOpenApi("updatePriceListEntry", updatedBody, ["entry"]);
    const afterUpdate = (
      updatedBody.data as {
        entry: { version: number; unitPrice: string; effectiveTo: string | null };
      }
    ).entry;
    expect(afterUpdate.unitPrice).toBe("10.500000");
    expect(afterUpdate.effectiveTo).toBe("2026-07-31");

    const immutable = await invoke(
      entryPatch,
      request(`${base}/pricing/price-list-entries/${entry.id}`, {
        method: "PATCH",
        json: {
          expectedVersion: afterUpdate.version,
          priceListAssignmentId: "nope",
        },
      }),
      { tenantId, entryId: entry.id },
    );
    expect(immutable.status).toBe(200);
    const afterImmutable = (
      (await readJson(immutable)).data as {
        entry: { priceListAssignmentId: string; version: number };
      }
    ).entry;
    expect(afterImmutable.priceListAssignmentId).toBe(list.assignment.id);

    const clearedTo = await invoke(
      entryPatch,
      request(`${base}/pricing/price-list-entries/${adjacentEntry.id}`, {
        method: "PATCH",
        json: { expectedVersion: adjacentEntry.version, effectiveTo: null },
      }),
      { tenantId, entryId: adjacentEntry.id },
    );
    expect(clearedTo.status).toBe(200);
    expect(
      ((await readJson(clearedTo)).data as { entry: { effectiveTo: string | null } })
        .entry.effectiveTo,
    ).toBeNull();

    const closed = await invoke(
      entryClose,
      request(`${base}/pricing/price-list-entries/${entry.id}/close`, {
        method: "POST",
        json: { expectedVersion: afterImmutable.version, effectiveTo: "2026-07-20" },
      }),
      { tenantId, entryId: entry.id },
    );
    expect(closed.status).toBe(200);
    const closedBody = await readJson(closed);
    assertMatchesOpenApi("closePriceListEntry", closedBody, ["entry"]);
    const afterClose = (
      closedBody.data as { entry: { version: number; effectiveTo: string | null } }
    ).entry;
    expect(afterClose.effectiveTo).toBe("2026-07-20");

    const extend = await invoke(
      entryClose,
      request(`${base}/pricing/price-list-entries/${entry.id}/close`, {
        method: "POST",
        json: { expectedVersion: afterClose.version, effectiveTo: "2026-07-25" },
      }),
      { tenantId, entryId: entry.id },
    );
    expect(extend.status).toBe(422);

    await updatePriceListAssignment(ctxAB, list.assignment.id, {
      expectedVersion: list.assignment.version,
      status: "SUSPENDED",
    });
    const afterInactive = await invoke(
      entryClose,
      request(`${base}/pricing/price-list-entries/${entry.id}/close`, {
        method: "POST",
        json: { expectedVersion: afterClose.version, effectiveTo: "2026-07-10" },
      }),
      { tenantId, entryId: entry.id },
    );
    expect(afterInactive.status).toBe(200);

    await updatePriceListAssignment(ctxAB, list.assignment.id, {
      expectedVersion: list.assignment.version + 1,
      status: "ACTIVE",
    });
    const otherList = await createTestPriceList(ctxAB, leA.id, "SGD", "Other");
    await updateCatalogItemAssignment(ctxAB, item.assignment.id, {
      expectedVersion: item.assignment.version,
      status: "SUSPENDED",
    });
    const inactiveItem = await invoke(
      entriesPost,
      request(`${base}/pricing/price-list-entries`, {
        method: "POST",
        json: {
          priceListAssignmentId: otherList.assignment.id,
          catalogItemAssignmentId: item.assignment.id,
          unitPrice: "1",
          effectiveFrom: "2026-12-01",
          effectiveTo: "2026-12-31",
        },
      }),
      { tenantId },
    );
    expect(inactiveItem.status).toBe(409);

    const csrfBefore = await writeBucketCounts(tenantId, userId);
    const csrfState = await withTenantContext(
      { tenantId, legalEntityIds: ctxAB.legalEntityIds },
      async (tx) => ({
        entries: await tx.priceListEntry.count({ where: { tenantId } }),
        audits: await tx.auditEvent.count({ where: { tenantId } }),
      }),
    );
    const csrfCreate = await invoke(
      entriesPost,
      request(`${base}/pricing/price-list-entries`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        json: {
          priceListAssignmentId: otherList.assignment.id,
          catalogItemAssignmentId: item.assignment.id,
          unitPrice: "1",
          effectiveFrom: "2026-05-01",
          effectiveTo: "2026-05-31",
        },
      }),
      { tenantId },
    );
    const csrfClose = await invoke(
      entryClose,
      request(`${base}/pricing/price-list-entries/${entry.id}/close`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        json: { expectedVersion: 99, effectiveTo: "2026-07-01" },
      }),
      { tenantId, entryId: entry.id },
    );
    expect(csrfCreate.status).toBe(403);
    expect(csrfClose.status).toBe(403);
    expect(await writeBucketCounts(tenantId, userId)).toEqual(csrfBefore);
    expect(
      await withTenantContext(
        { tenantId, legalEntityIds: ctxAB.legalEntityIds },
        async (tx) => ({
          entries: await tx.priceListEntry.count({ where: { tenantId } }),
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
    expect(
      events.some((row) => row.action === AUDIT_ACTIONS.PRICE_LIST_ENTRY_CREATED),
    ).toBe(true);
    expect(
      events.some((row) => row.action === AUDIT_ACTIONS.PRICE_LIST_ENTRY_CLOSED),
    ).toBe(true);
  }, 120_000);

  it("pages entries across a shared effectiveFrom cursor boundary", async () => {
    fixture = await setupPricingDomainFixture();
    const { setup, ctxAB, leA } = fixture;
    const tenantId = setup.tenantId;
    pricingApiAuth.userId = setup.adminUserId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const uom = await createTestUom(ctxAB);
    const list = await createTestPriceList(ctxAB, leA.id);
    const other = await createTestPriceList(ctxAB, leA.id, "SGD", "Other");
    const items = [];
    for (const name of ["E1", "E2", "E3", "E4", "E5", "E6"] as const) {
      items.push(await createTestItem(ctxAB, leA.id, uom.id, name));
    }
    const seeds = [
      { item: items[0]!, from: "2026-10-01", to: "2026-10-31" },
      { item: items[1]!, from: "2026-08-01", to: "2026-08-31" },
      { item: items[2]!, from: "2026-08-01", to: "2026-08-31" },
      { item: items[3]!, from: "2026-08-01", to: "2026-08-31" },
      { item: items[4]!, from: "2026-07-01", to: "2026-07-31" },
    ];
    const created = [];
    for (const seed of seeds) {
      created.push(
        await createPriceListEntry(ctxAB, {
          priceListAssignmentId: list.assignment.id,
          catalogItemAssignmentId: seed.item.assignment.id,
          unitPrice: "1",
          effectiveFrom: seed.from,
          effectiveTo: seed.to,
        }),
      );
    }
    await createPriceListEntry(ctxAB, {
      priceListAssignmentId: other.assignment.id,
      catalogItemAssignmentId: items[5]!.assignment.id,
      unitPrice: "9",
      effectiveFrom: "2026-08-01",
      effectiveTo: "2026-08-31",
    });
    const expected = [...created].sort((left, right) => {
      if (left.effectiveFrom !== right.effectiveFrom) {
        return left.effectiveFrom < right.effectiveFrom ? 1 : -1;
      }
      return left.id < right.id ? 1 : -1;
    });
    expect(expected.filter((row) => row.effectiveFrom === "2026-08-01")).toHaveLength(3);

    type Page = {
      entries: Array<{
        id: string;
        effectiveFrom: string;
        priceListAssignmentId: string;
      }>;
      nextCursor: string | null;
    };
    const filter = `priceListAssignmentId=${encodeURIComponent(list.assignment.id)}&limit=2`;
    const pages: Page[] = [];
    let cursor: string | null = null;
    for (let step = 0; step < 8; step += 1) {
      const query = cursor ? `${filter}&cursor=${encodeURIComponent(cursor)}` : filter;
      const res = await invoke(
        entriesGet,
        request(`${base}/pricing/price-list-entries?${query}`),
        { tenantId },
      );
      expect(res.status).toBe(200);
      const body = (await readJson(res)).data as Page;
      expect(
        body.entries.every((row) => row.priceListAssignmentId === list.assignment.id),
      ).toBe(true);
      if (cursor !== null) {
        expect(cursor.length).toBeGreaterThan(0);
        expect(cursor.includes("{")).toBe(false);
      }
      pages.push(body);
      if (body.nextCursor == null) break;
      expect(typeof body.nextCursor).toBe("string");
      cursor = body.nextCursor;
    }

    expect(pages[0]?.entries).toHaveLength(2);
    expect(pages[0]?.nextCursor).toEqual(expect.any(String));
    expect(pages.at(-1)?.nextCursor).toBeNull();
    const traversed = pages.flatMap((page) => page.entries);
    expect(traversed.map((row) => row.id)).toEqual(expected.map((row) => row.id));
    expect(traversed.map((row) => row.effectiveFrom)).toEqual(
      expected.map((row) => row.effectiveFrom),
    );
    expect(new Set(traversed.map((row) => row.id)).size).toBe(expected.length);

    const split = pages.some((page, index) => {
      if (index === pages.length - 1) return false;
      const last = page.entries.at(-1);
      const next = pages[index + 1]?.entries[0];
      return (
        last?.effectiveFrom === "2026-08-01" &&
        next?.effectiveFrom === "2026-08-01" &&
        next.id < last.id
      );
    });
    expect(split).toBe(true);

    const malformed = await invoke(
      entriesGet,
      request(`${base}/pricing/price-list-entries?${filter}&cursor=not-a-cursor`),
      { tenantId },
    );
    expect(malformed.status).toBe(422);
  }, 120_000);
});
