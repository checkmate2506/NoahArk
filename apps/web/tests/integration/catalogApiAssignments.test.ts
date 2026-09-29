import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { AUDIT_ACTIONS, verifyAuditChain } from "@noahark/audit";
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
import { createSystemClient } from "@noahark/db/system";
import {
  GET as assignmentsGet,
  POST as assignmentsPost,
} from "@/app/api/v1/tenants/[tenantId]/catalog/item-assignments/route";
import {
  GET as assignmentGet,
  PATCH as assignmentPatch,
} from "@/app/api/v1/tenants/[tenantId]/catalog/item-assignments/[assignmentId]/route";
import { POST as assignmentArchive } from "@/app/api/v1/tenants/[tenantId]/catalog/item-assignments/[assignmentId]/archive/route";
import { cleanupTenant, cleanupUser, uniqueSlug } from "./testHelpers";
import {
  catalogCode,
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

describe("P2D.3a CatalogItem assignment APIs", () => {
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

  it("covers assignment CRUD, last-ACTIVE, archive permanence, pagination, CSRF and OpenAPI", async () => {
    fixture = await setupCatalogDomainFixture();
    const { setup, leA, leB, leC, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const userId = setup.adminUserId;
    catalogApiAuth.userId = userId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const uom = await createTestUom(ctxAB);
    const seeded = await createCatalogItem(ctxAB, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Assign item",
      baseUomId: uom.id,
    });
    const createRequestId = uniqueSlug("rid");
    const reservedCode = catalogCode("EIC");
    const createdRes = await invoke(
      assignmentsPost,
      request(`${base}/catalog/item-assignments`, {
        method: "POST",
        headers: { "x-request-id": createRequestId },
        json: {
          catalogItemId: seeded.item.id,
          legalEntityId: leB.id,
          entityItemCode: reservedCode,
          permissions: ["catalog_item_assignment:create"],
          requestId: "forged-rid",
        },
      }),
      { tenantId },
    );
    expect(createdRes.status).toBe(201);
    const createdBody = await readJson(createdRes);
    assertMatchesOpenApi("createCatalogItemAssignment", createdBody, ["assignment"]);
    const assignment = (
      createdBody.data as {
        assignment: {
          id: string;
          version: number;
          status: string;
          entityItemCode: string | null;
          legalEntityId: string;
        };
      }
    ).assignment;
    expect(assignment.legalEntityId).toBe(leB.id);
    expect(assignment.status).toBe("ACTIVE");
    expect(assignment.entityItemCode).toBe(reservedCode);

    const getRes = await invoke(
      assignmentGet,
      request(`${base}/catalog/item-assignments/${assignment.id}`),
      { tenantId, assignmentId: assignment.id },
    );
    expect(getRes.status).toBe(200);
    assertMatchesOpenApi("getCatalogItemAssignment", await readJson(getRes), [
      "assignment",
    ]);

    const listed = await invoke(
      assignmentsGet,
      request(`${base}/catalog/item-assignments?catalogItemId=${seeded.item.id}`),
      { tenantId },
    );
    expect(listed.status).toBe(200);
    const listedBody = await readJson(listed);
    assertMatchesOpenApi("listCatalogItemAssignments", listedBody, [
      "assignments",
      "nextCursor",
    ]);

    const updated = await invoke(
      assignmentPatch,
      request(`${base}/catalog/item-assignments/${assignment.id}`, {
        method: "PATCH",
        json: { expectedVersion: assignment.version, entityItemCode: "B-1" },
      }),
      { tenantId, assignmentId: assignment.id },
    );
    expect(updated.status).toBe(200);
    const updatedBody = await readJson(updated);
    assertMatchesOpenApi("updateCatalogItemAssignment", updatedBody, ["assignment"]);
    const afterUpdate = (
      updatedBody.data as {
        assignment: { version: number; entityItemCode: string | null };
      }
    ).assignment;

    const duplicate = await invoke(
      assignmentsPost,
      request(`${base}/catalog/item-assignments`, {
        method: "POST",
        json: { catalogItemId: seeded.item.id, legalEntityId: leB.id },
      }),
      { tenantId },
    );
    expect(duplicate.status).toBe(409);
    expect(errorCode(await readJson(duplicate))).toBe("CONFLICT");

    const extra = await createCatalogItemAssignment(ctxAB, {
      catalogItemId: seeded.item.id,
      legalEntityId: leC.id,
    });
    const ownerAssign = seeded.assignment;
    const archivedRes = await invoke(
      assignmentArchive,
      request(`${base}/catalog/item-assignments/${extra.id}/archive`, {
        method: "POST",
        json: { expectedVersion: extra.version },
      }),
      { tenantId, assignmentId: extra.id },
    );
    expect(archivedRes.status).toBe(200);
    const archivedBody = await readJson(archivedRes);
    assertMatchesOpenApi("archiveCatalogItemAssignment", archivedBody, ["assignment"]);
    const archived = (
      archivedBody.data as {
        assignment: {
          id: string;
          status: string;
          version: number;
          entityItemCode: string | null;
        };
      }
    ).assignment;
    expect(archived.status).toBe("ARCHIVED");

    const assignmentSchema = OPENAPI_DOC.components?.schemas?.CatalogItemAssignment;
    const brokenStatus: OpenApiSchema = {
      ...assignmentSchema!,
      properties: {
        ...assignmentSchema!.properties,
        status: { type: "string", enum: ["ACTIVE"] },
      },
    };
    expect(
      validateOpenApiValue(
        OPENAPI_DOC,
        brokenStatus,
        archived,
        "broken-assignment-status",
      ).some((error) => error.includes("enum")),
    ).toBe(true);

    const revive = await invoke(
      assignmentPatch,
      request(`${base}/catalog/item-assignments/${archived.id}`, {
        method: "PATCH",
        json: { expectedVersion: archived.version, status: "ACTIVE" },
      }),
      { tenantId, assignmentId: archived.id },
    );
    expect(revive.status).toBe(422);

    const recreateArchivedPair = await invoke(
      assignmentsPost,
      request(`${base}/catalog/item-assignments`, {
        method: "POST",
        json: { catalogItemId: seeded.item.id, legalEntityId: leC.id },
      }),
      { tenantId },
    );
    expect(recreateArchivedPair.status).toBe(409);

    const ownerArchived = await invoke(
      assignmentArchive,
      request(`${base}/catalog/item-assignments/${ownerAssign.id}/archive`, {
        method: "POST",
        json: { expectedVersion: ownerAssign.version },
      }),
      { tenantId, assignmentId: ownerAssign.id },
    );
    expect(ownerArchived.status).toBe(200);

    const lastSuspend = await invoke(
      assignmentPatch,
      request(`${base}/catalog/item-assignments/${assignment.id}`, {
        method: "PATCH",
        json: { expectedVersion: afterUpdate.version, status: "SUSPENDED" },
      }),
      { tenantId, assignmentId: assignment.id },
    );
    expect(lastSuspend.status).toBe(409);
    expect(errorCode(await readJson(lastSuspend))).toBe("CONFLICT");

    const lastArchive = await invoke(
      assignmentArchive,
      request(`${base}/catalog/item-assignments/${assignment.id}/archive`, {
        method: "POST",
        json: { expectedVersion: afterUpdate.version },
      }),
      { tenantId, assignmentId: assignment.id },
    );
    expect(lastArchive.status).toBe(409);
    expect(errorCode(await readJson(lastArchive))).toBe("CONFLICT");

    const extraStatus = await invoke(
      assignmentArchive,
      request(`${base}/catalog/item-assignments/${assignment.id}/archive`, {
        method: "POST",
        json: { expectedVersion: afterUpdate.version, extra: 1 },
      }),
      { tenantId, assignmentId: assignment.id },
    );
    expect(extraStatus.status).toBe(422);

    const missingItem = await invoke(
      assignmentsPost,
      request(`${base}/catalog/item-assignments`, {
        method: "POST",
        json: { catalogItemId: "does-not-exist", legalEntityId: leB.id },
      }),
      { tenantId },
    );
    expect(missingItem.status).toBe(404);

    for (let i = 0; i < 26; i += 1) {
      const row = await createCatalogItem(ctxAB, {
        ownerLegalEntityId: leA.id,
        code: catalogCode("PG"),
        itemType: "PRODUCT",
        name: `Assign page ${i}`,
        baseUomId: uom.id,
      });
      await createCatalogItemAssignment(ctxAB, {
        catalogItemId: row.item.id,
        legalEntityId: leB.id,
      });
    }
    const page1 = await invoke(
      assignmentsGet,
      request(`${base}/catalog/item-assignments?limit=25`),
      { tenantId },
    );
    const page1Body = (await readJson(page1)).data as {
      assignments: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(page1Body.assignments).toHaveLength(25);
    expect(page1Body.nextCursor).toBeTruthy();
    const page2 = await invoke(
      assignmentsGet,
      request(
        `${base}/catalog/item-assignments?limit=25&cursor=${encodeURIComponent(page1Body.nextCursor!)}`,
      ),
      { tenantId },
    );
    const page2Body = (await readJson(page2)).data as {
      assignments: Array<{ id: string }>;
      nextCursor: string | null;
    };
    const ids = [...page1Body.assignments, ...page2Body.assignments].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    const leFilter = await invoke(
      assignmentsGet,
      request(`${base}/catalog/item-assignments?legalEntityId=${leB.id}&limit=100`),
      { tenantId },
    );
    const leRows = (
      (await readJson(leFilter)).data as { assignments: Array<{ legalEntityId: string }> }
    ).assignments;
    expect(leRows.every((row) => row.legalEntityId === leB.id)).toBe(true);
    expect(
      (
        await invoke(
          assignmentsGet,
          request(`${base}/catalog/item-assignments?limit=0`),
          {
            tenantId,
          },
        )
      ).status,
    ).toBe(422);

    const csrfBefore = await writeBucketCounts(tenantId, userId);
    const csrfState = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        assignments: await tx.catalogItemLegalEntityAssignment.count({
          where: { tenantId },
        }),
        audits: await tx.auditEvent.count({ where: { tenantId } }),
      }),
    );
    const csrfArchive = await invoke(
      assignmentArchive,
      request(`${base}/catalog/item-assignments/${assignment.id}/archive`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        json: { expectedVersion: afterUpdate.version },
      }),
      { tenantId, assignmentId: assignment.id },
    );
    expect(csrfArchive.status).toBe(403);
    expect(await writeBucketCounts(tenantId, userId)).toEqual(csrfBefore);
    expect(
      await withTenantContext(
        { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
        async (tx) => ({
          assignments: await tx.catalogItemLegalEntityAssignment.count({
            where: { tenantId },
          }),
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
        row.action === AUDIT_ACTIONS.CATALOG_ITEM_ASSIGNMENT_CREATED &&
        row.entityId === assignment.id,
    );
    expect(createdAudit?.requestId).toBe(createRequestId);
    expect(createdAudit?.actorUserId).toBe(userId);
    expect(
      audits.some(
        (row) =>
          row.action === AUDIT_ACTIONS.CATALOG_ITEM_ASSIGNMENT_UPDATED &&
          row.entityId === assignment.id,
      ),
    ).toBe(true);
    expect(
      audits.some(
        (row) =>
          row.action === AUDIT_ACTIONS.CATALOG_ITEM_ASSIGNMENT_ARCHIVED &&
          row.entityId === extra.id,
      ),
    ).toBe(true);
    expect(
      audits.filter(
        (row) =>
          row.action === AUDIT_ACTIONS.CATALOG_ITEM_ASSIGNMENT_ARCHIVED &&
          row.entityId === assignment.id,
      ),
    ).toHaveLength(0);
  }, 120_000);
});
