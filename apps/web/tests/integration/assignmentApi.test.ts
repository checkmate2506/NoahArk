import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { AUDIT_ACTIONS, verifyAuditChain } from "@noahark/audit";
import { withTenantContext } from "@noahark/db";
import { createAssignment, createParty } from "@noahark/crm";
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
} from "@/app/api/v1/tenants/[tenantId]/party-assignments/route";
import {
  GET as assignmentGet,
  PATCH as assignmentPatch,
} from "@/app/api/v1/tenants/[tenantId]/party-assignments/[assignmentId]/route";
import { POST as assignmentRevoke } from "@/app/api/v1/tenants/[tenantId]/party-assignments/[assignmentId]/revoke/route";
import { cleanupTenant, cleanupUser, uniqueSlug } from "./testHelpers";
import {
  partyCode,
  setupPartyDomainFixture,
  type PartyDomainFixture,
} from "./partyDomainFixture";
import {
  OPENAPI_DOC,
  type OpenApiSchema,
  assertMatchesOpenApi,
  validateOpenApiValue,
} from "./openapiResponseValidator";

const { partyApiAuth } = vi.hoisted(() => ({
  partyApiAuth: { userId: undefined as string | undefined },
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
      if (!partyApiAuth.userId) throw new UnauthenticatedError();
      return actual.getAccessContext(
        partyApiAuth.userId,
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

describe("P2D.2b assignment APIs", () => {
  let fixture: PartyDomainFixture | undefined;

  afterEach(async () => {
    partyApiAuth.userId = undefined;
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("covers assignment CRUD, pagination, last-ACTIVE, audit, CSRF and nested OpenAPI", async () => {
    fixture = await setupPartyDomainFixture();
    const { setup, leA, leB, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const userId = setup.adminUserId;
    partyApiAuth.userId = userId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const created = await createParty(ctxAB, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Assign Api Co",
    });
    const createRequestId = uniqueSlug("rid");
    const beforeBuckets = await writeBucketCounts(tenantId, userId);
    const createdRes = await invoke(
      assignmentsPost,
      request(`${base}/party-assignments`, {
        method: "POST",
        headers: { "x-request-id": createRequestId },
        json: {
          partyId: created.party.id,
          legalEntityId: leB.id,
          actingUserId: "forged-user",
          requestId: "forged-rid",
          tenantId: "forged-tenant",
          permissions: ["party_assignment:create"],
        },
      }),
      { tenantId },
    );
    expect(createdRes.status).toBe(201);
    const createdBody = await readJson(createdRes);
    assertMatchesOpenApi("createPartyAssignment", createdBody, ["assignment"]);
    const assignment = (
      createdBody.data as {
        assignment: {
          id: string;
          version: number;
          status: string;
          legalEntityId: string;
        };
      }
    ).assignment;
    expect(assignment.legalEntityId).toBe(leB.id);
    expect(assignment.status).toBe("ACTIVE");
    expect(await writeBucketCounts(tenantId, userId)).toEqual({
      user: beforeBuckets.user + 1,
      tenant: beforeBuckets.tenant + 1,
    });

    const listed = await invoke(assignmentsGet, request(`${base}/party-assignments`), {
      tenantId,
    });
    expect(listed.status).toBe(200);
    assertMatchesOpenApi("listPartyAssignments", await readJson(listed.clone()), [
      "assignments",
      "nextCursor",
    ]);

    const got = await invoke(
      assignmentGet,
      request(`${base}/party-assignments/${assignment.id}`),
      { tenantId, assignmentId: assignment.id },
    );
    expect(got.status).toBe(200);
    assertMatchesOpenApi("getPartyAssignment", await readJson(got), ["assignment"]);

    const patched = await invoke(
      assignmentPatch,
      request(`${base}/party-assignments/${assignment.id}`, {
        method: "PATCH",
        json: { expectedVersion: assignment.version, status: "SUSPENDED" },
      }),
      { tenantId, assignmentId: assignment.id },
    );
    expect(patched.status).toBe(200);
    const patchedBody = await readJson(patched);
    assertMatchesOpenApi("updatePartyAssignment", patchedBody, ["assignment"]);
    const suspended = (
      patchedBody.data as { assignment: { version: number; status: string } }
    ).assignment;
    expect(suspended.status).toBe("SUSPENDED");

    const reactivated = await invoke(
      assignmentPatch,
      request(`${base}/party-assignments/${assignment.id}`, {
        method: "PATCH",
        json: { expectedVersion: suspended.version, status: "ACTIVE" },
      }),
      { tenantId, assignmentId: assignment.id },
    );
    expect(reactivated.status).toBe(200);
    const activeAgain = (
      (await readJson(reactivated)).data as { assignment: { version: number } }
    ).assignment;

    const duplicate = await invoke(
      assignmentsPost,
      request(`${base}/party-assignments`, {
        method: "POST",
        json: { partyId: created.party.id, legalEntityId: leB.id },
      }),
      { tenantId },
    );
    expect(duplicate.status).toBe(409);
    expect(errorCode(await readJson(duplicate))).toBe("CONFLICT");

    const malformed = await invoke(
      assignmentsPost,
      new Request(`${base}/party-assignments`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": uniqueSlug("rid"),
        },
        body: "{",
      }),
      { tenantId },
    );
    expect(malformed.status).toBe(422);

    const stale = await invoke(
      assignmentPatch,
      request(`${base}/party-assignments/${assignment.id}`, {
        method: "PATCH",
        json: { expectedVersion: 1, status: "SUSPENDED" },
      }),
      { tenantId, assignmentId: assignment.id },
    );
    expect(stale.status).toBe(409);
    expect(errorCode(await readJson(stale))).toBe("STALE_VERSION");

    const revoked = await invoke(
      assignmentRevoke,
      request(`${base}/party-assignments/${assignment.id}/revoke`, {
        method: "POST",
        json: { expectedVersion: activeAgain.version },
      }),
      { tenantId, assignmentId: assignment.id },
    );
    expect(revoked.status).toBe(200);
    const revokedBody = await readJson(revoked);
    assertMatchesOpenApi("revokePartyAssignment", revokedBody, ["assignment"]);
    const revokedRow = (
      revokedBody.data as { assignment: { status: string; version: number } }
    ).assignment;
    expect(revokedRow.status).toBe("ARCHIVED");

    const lastSuspend = await invoke(
      assignmentPatch,
      request(`${base}/party-assignments/${created.assignment.id}`, {
        method: "PATCH",
        json: { expectedVersion: created.assignment.version, status: "SUSPENDED" },
      }),
      { tenantId, assignmentId: created.assignment.id },
    );
    expect(lastSuspend.status).toBe(409);
    expect(errorCode(await readJson(lastSuspend))).toBe("CONFLICT");

    const lastRevoke = await invoke(
      assignmentRevoke,
      request(`${base}/party-assignments/${created.assignment.id}/revoke`, {
        method: "POST",
        json: { expectedVersion: created.assignment.version },
      }),
      { tenantId, assignmentId: created.assignment.id },
    );
    expect(lastRevoke.status).toBe(409);
    expect(errorCode(await readJson(lastRevoke))).toBe("CONFLICT");

    const revive = await invoke(
      assignmentPatch,
      request(`${base}/party-assignments/${assignment.id}`, {
        method: "PATCH",
        json: { expectedVersion: revokedRow.version, status: "ACTIVE" },
      }),
      { tenantId, assignmentId: assignment.id },
    );
    expect(revive.status).toBe(422);

    const assignmentSchema = OPENAPI_DOC.components?.schemas?.PartyAssignment;
    const broken: OpenApiSchema = {
      ...assignmentSchema!,
      properties: {
        ...assignmentSchema!.properties,
        status: { type: "string", enum: ["ACTIVE"] },
      },
    };
    expect(
      validateOpenApiValue(
        OPENAPI_DOC,
        broken,
        (revokedBody.data as { assignment: unknown }).assignment,
        "broken-assignment",
      ).some((error) => error.includes("enum")),
    ).toBe(true);

    const csrfBefore = await writeBucketCounts(tenantId, userId);
    const csrfState = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        assignments: await tx.partyLegalEntityAssignment.count({ where: { tenantId } }),
        audits: await tx.auditEvent.count({ where: { tenantId } }),
      }),
    );
    const csrf = await invoke(
      assignmentsPost,
      request(`${base}/party-assignments`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        json: { partyId: created.party.id, legalEntityId: leB.id },
      }),
      { tenantId },
    );
    const csrfPatch = await invoke(
      assignmentPatch,
      request(`${base}/party-assignments/${created.assignment.id}`, {
        method: "PATCH",
        headers: { Origin: "https://evil.example" },
        json: { expectedVersion: created.assignment.version, status: "SUSPENDED" },
      }),
      { tenantId, assignmentId: created.assignment.id },
    );
    const csrfRevoke = await invoke(
      assignmentRevoke,
      request(`${base}/party-assignments/${created.assignment.id}/revoke`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        json: { expectedVersion: created.assignment.version },
      }),
      { tenantId, assignmentId: created.assignment.id },
    );
    expect(csrf.status).toBe(403);
    expect(csrfPatch.status).toBe(403);
    expect(csrfRevoke.status).toBe(403);
    expect(await writeBucketCounts(tenantId, userId)).toEqual(csrfBefore);
    expect(
      await withTenantContext(
        { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
        async (tx) => ({
          assignments: await tx.partyLegalEntityAssignment.count({ where: { tenantId } }),
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
      (a) =>
        a.action === AUDIT_ACTIONS.PARTY_ASSIGNMENT_CREATED &&
        a.entityId === assignment.id,
    );
    expect(createdAudit?.actorUserId).toBe(userId);
    expect(createdAudit?.requestId).toBe(createRequestId);
    expect(
      JSON.stringify(audits, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toContain("forged-user");

    for (let i = 0; i < 105; i++) {
      await createParty(ctxAB, {
        ownerLegalEntityId: leA.id,
        code: partyCode(),
        partyType: "ORGANISATION",
        legalName: `Page Assign ${i}`,
      });
    }
    const firstPage = await invoke(
      assignmentsGet,
      request(`${base}/party-assignments?limit=101&partyId=${created.party.id}`),
      { tenantId },
    );
    expect(firstPage.status).toBe(200);
    const filtered = (
      (await readJson(firstPage)).data as { assignments: Array<{ id: string }> }
    ).assignments;
    expect(filtered.map((row) => row.id).sort()).toEqual(
      [created.assignment.id, assignment.id].sort(),
    );
    const combined = await invoke(
      assignmentsGet,
      request(
        `${base}/party-assignments?partyId=${created.party.id}&legalEntityId=${leA.id}`,
      ),
      { tenantId },
    );
    expect(
      (
        (await readJson(combined)).data as { assignments: Array<{ id: string }> }
      ).assignments.map((row) => row.id),
    ).toEqual([created.assignment.id]);
    const leFilter = await invoke(
      assignmentsGet,
      request(`${base}/party-assignments?legalEntityId=${leB.id}`),
      { tenantId },
    );
    const leIds = (
      (await readJson(leFilter)).data as { assignments: Array<{ legalEntityId: string }> }
    ).assignments.map((row) => row.legalEntityId);
    expect(leIds.every((id) => id === leB.id)).toBe(true);

    const cap = await invoke(
      assignmentsGet,
      request(`${base}/party-assignments?limit=101`),
      {
        tenantId,
      },
    );
    expect(cap.status).toBe(200);
    const capData = (await readJson(cap)).data as {
      assignments: Array<{ id: string; createdAt: string }>;
      nextCursor: string | null;
    };
    expect(capData.assignments).toHaveLength(100);
    expect(capData.nextCursor).not.toBeNull();
    const seen = new Set(capData.assignments.map((row) => row.id));
    let cursor = capData.nextCursor;
    while (cursor) {
      const page = await invoke(
        assignmentsGet,
        request(
          `${base}/party-assignments?limit=101&cursor=${encodeURIComponent(cursor)}`,
        ),
        { tenantId },
      );
      const pageData = (await readJson(page)).data as {
        assignments: Array<{ id: string }>;
        nextCursor: string | null;
      };
      for (const row of pageData.assignments) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      cursor = pageData.nextCursor;
    }
    expect(cursor).toBeNull();
    const defaultPage = await invoke(
      assignmentsGet,
      request(`${base}/party-assignments`),
      {
        tenantId,
      },
    );
    expect(
      ((await readJson(defaultPage)).data as { assignments: unknown[] }).assignments,
    ).toHaveLength(25);
    expect(
      (
        await invoke(
          assignmentsGet,
          request(`${base}/party-assignments?cursor=not-a-cursor`),
          {
            tenantId,
          },
        )
      ).status,
    ).toBe(422);
    for (let i = 1; i < capData.assignments.length; i++) {
      const prev = capData.assignments[i - 1]!;
      const cur = capData.assignments[i]!;
      expect(`${prev.createdAt}|${prev.id}` <= `${cur.createdAt}|${cur.id}`).toBe(true);
    }
    expect(
      (
        await invoke(assignmentsGet, request(`${base}/party-assignments?limit=0`), {
          tenantId,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await invoke(
          assignmentsGet,
          request(`${base}/party-assignments?limit=1&limit=2`),
          {
            tenantId,
          },
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await invoke(assignmentsGet, request(`${base}/party-assignments?unknown=1`), {
          tenantId,
        })
      ).status,
    ).toBe(422);
  }, 120_000);

  it("lets exactly one concurrent last-ACTIVE assignment mutation commit", async () => {
    fixture = await setupPartyDomainFixture();
    const { setup, leA, leB, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    partyApiAuth.userId = setup.adminUserId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const created = await createParty(ctxAB, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Race Assign Co",
    });
    const extraAssign = await createAssignment(ctxAB, {
      partyId: created.party.id,
      legalEntityId: leB.id,
    });
    const pendingFirst = invoke(
      assignmentRevoke,
      request(`${base}/party-assignments/${created.assignment.id}/revoke`, {
        method: "POST",
        json: { expectedVersion: created.assignment.version },
      }),
      { tenantId, assignmentId: created.assignment.id },
    );
    const pendingSecond = invoke(
      assignmentRevoke,
      request(`${base}/party-assignments/${extraAssign.id}/revoke`, {
        method: "POST",
        json: { expectedVersion: extraAssign.version },
      }),
      { tenantId, assignmentId: extraAssign.id },
    );
    const settled = await Promise.allSettled([pendingFirst, pendingSecond]);
    expect(settled.every((row) => row.status === "fulfilled")).toBe(true);
    const results = settled.map((row) => (row as PromiseFulfilledResult<Response>).value);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(errorCode(await readJson(results.find((r) => r.status === 409)!))).toBe(
      "CONFLICT",
    );
    const remaining = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) =>
        tx.partyLegalEntityAssignment.count({
          where: { partyId: created.party.id, status: "ACTIVE" },
        }),
    );
    expect(remaining).toBeGreaterThanOrEqual(1);
    const audits = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) =>
        tx.auditEvent.findMany({ where: { tenantId }, orderBy: { sequence: "asc" } }),
    );
    const revokes = audits.filter(
      (a) => a.action === AUDIT_ACTIONS.PARTY_ASSIGNMENT_REVOKED,
    );
    expect(revokes).toHaveLength(1);
    expect(verifyAuditChain(toLinks(audits)).valid).toBe(true);
  }, 60_000);
});
