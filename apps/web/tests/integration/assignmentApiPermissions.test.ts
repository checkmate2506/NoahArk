import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { PERMISSIONS } from "@noahark/authz";
import { createSystemClient } from "@noahark/db/system";
import { withTenantContext } from "@noahark/db";
import { createAssignment, createParty } from "@noahark/crm";
import {
  API_WRITE_TENANT,
  API_WRITE_TENANT_USER,
  apiWriteCanonicalKey,
  hashKey,
} from "@/lib/rateLimiter";
import {
  GET as assignmentsGet,
  POST as assignmentsPost,
} from "@/app/api/v1/tenants/[tenantId]/party-assignments/route";
import {
  GET as assignmentGet,
  PATCH as assignmentPatch,
} from "@/app/api/v1/tenants/[tenantId]/party-assignments/[assignmentId]/route";
import { POST as assignmentRevoke } from "@/app/api/v1/tenants/[tenantId]/party-assignments/[assignmentId]/revoke/route";
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
  partyCode,
  setupPartyDomainFixture,
  type PartyDomainFixture,
} from "./partyDomainFixture";

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

describe("P2D.2b assignment API permissions", () => {
  let fixture: PartyDomainFixture | undefined;
  const extraUsers: string[] = [];

  afterEach(async () => {
    partyApiAuth.userId = undefined;
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
      partyId: string;
      assignmentId: string;
      version: number;
      leA: string;
      leB: string;
    }) => {
      handler: LooseHandler;
      req: Request;
      params: { tenantId: string } & Record<string, string>;
    };
  }> = [
    {
      name: "GET /party-assignments",
      permission: PERMISSIONS.PARTY_ASSIGNMENT_READ,
      neighbor: PERMISSIONS.PARTY_ASSIGNMENT_CREATE,
      success: 200,
      write: false,
      run: ({ base, tenantId }) => ({
        handler: assignmentsGet as unknown as LooseHandler,
        req: request(`${base}/party-assignments`),
        params: { tenantId },
      }),
    },
    {
      name: "POST /party-assignments",
      permission: PERMISSIONS.PARTY_ASSIGNMENT_CREATE,
      neighbor: PERMISSIONS.PARTY_ASSIGNMENT_UPDATE,
      success: 201,
      write: true,
      run: ({ base, tenantId, partyId, leB }) => ({
        handler: assignmentsPost as unknown as LooseHandler,
        req: request(`${base}/party-assignments`, {
          method: "POST",
          json: {
            partyId,
            legalEntityId: leB,
            permissions: [PERMISSIONS.PARTY_ASSIGNMENT_CREATE],
            actingUserId: "forged",
            requestId: "forged",
            tenantId: "forged",
            legalEntityIds: [leB],
          },
        }),
        params: { tenantId },
      }),
    },
    {
      name: "GET /party-assignments/{id}",
      permission: PERMISSIONS.PARTY_ASSIGNMENT_READ,
      neighbor: PERMISSIONS.PARTY_ASSIGNMENT_UPDATE,
      success: 200,
      write: false,
      run: ({ base, tenantId, assignmentId }) => ({
        handler: assignmentGet as unknown as LooseHandler,
        req: request(`${base}/party-assignments/${assignmentId}`),
        params: { tenantId, assignmentId },
      }),
    },
    {
      name: "PATCH /party-assignments/{id}",
      permission: PERMISSIONS.PARTY_ASSIGNMENT_UPDATE,
      neighbor: PERMISSIONS.PARTY_ASSIGNMENT_REVOKE,
      success: 200,
      write: true,
      run: ({ base, tenantId, assignmentId, version }) => ({
        handler: assignmentPatch as unknown as LooseHandler,
        req: request(`${base}/party-assignments/${assignmentId}`, {
          method: "PATCH",
          json: {
            expectedVersion: version,
            status: "SUSPENDED",
            permissions: [PERMISSIONS.PARTY_ASSIGNMENT_UPDATE],
          },
        }),
        params: { tenantId, assignmentId },
      }),
    },
    {
      name: "POST /party-assignments/{id}/revoke",
      permission: PERMISSIONS.PARTY_ASSIGNMENT_REVOKE,
      neighbor: PERMISSIONS.PARTY_ASSIGNMENT_UPDATE,
      success: 200,
      write: true,
      run: ({ base, tenantId, assignmentId, version }) => ({
        handler: assignmentRevoke as unknown as LooseHandler,
        req: request(`${base}/party-assignments/${assignmentId}/revoke`, {
          method: "POST",
          json: { expectedVersion: version },
        }),
        params: { tenantId, assignmentId },
      }),
    },
  ];

  it("grants only the exact tenant-wide key for each assignment operation", async () => {
    fixture = await setupPartyDomainFixture();
    const { setup, leA, leB, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    for (const op of matrix) {
      const created = await createParty(ctxAB, {
        ownerLegalEntityId: leA.id,
        code: partyCode(),
        partyType: "ORGANISATION",
        legalName: `Perm ${op.name}`,
      });
      const extra =
        op.name === "POST /party-assignments"
          ? created.assignment
          : await createAssignment(ctxAB, {
              partyId: created.party.id,
              legalEntityId: leB.id,
            });
      const actor = await createActor(
        tenantId,
        setup.adminUserId,
        [op.permission],
        [leA.id, leB.id],
      );
      extraUsers.push(actor.id);
      partyApiAuth.userId = actor.id;
      const target = op.name.includes("revoke") ? extra : created.assignment;
      const call = op.run({
        base,
        tenantId,
        partyId: created.party.id,
        assignmentId: target.id,
        version: target.version,
        leA: leA.id,
        leB: leB.id,
      });
      expect(
        (await invokeLoose(call.handler, call.req, call.params)).status,
        op.name,
      ).toBe(op.success);
    }
  }, 90_000);

  it("rejects a missing key, a neighbouring key, and forged body authority", async () => {
    fixture = await setupPartyDomainFixture();
    const { setup, leA, leB, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const created = await createParty(ctxAB, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Denied Assign Co",
    });
    const extra = await createAssignment(ctxAB, {
      partyId: created.party.id,
      legalEntityId: leB.id,
    });
    const snapshot = () =>
      withTenantContext(
        { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
        async (tx) => ({
          assignments: await tx.partyLegalEntityAssignment.count({ where: { tenantId } }),
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
        partyId: created.party.id,
        assignmentId: extra.id,
        version: extra.version,
        leA: leA.id,
        leB: leB.id,
      });
      const before = await snapshot();
      const beforeBuckets = await writeBucketCounts(tenantId, none.id);
      partyApiAuth.userId = none.id;
      expect(
        (await invokeLoose(call.handler, call.req.clone(), call.params)).status,
        `${op.name} absent`,
      ).toBe(403);
      partyApiAuth.userId = neighbor.id;
      expect(
        (await invokeLoose(call.handler, call.req.clone(), call.params)).status,
        `${op.name} neighbor`,
      ).toBe(403);
      expect(await snapshot(), `${op.name} snapshot`).toEqual(before);
      if (op.write) {
        expect(await writeBucketCounts(tenantId, none.id)).toEqual(beforeBuckets);
      }
    }
  }, 90_000);

  it("keeps entity-scoped assignment-create on the matching body legal entity only", async () => {
    fixture = await setupPartyDomainFixture();
    const { setup, leA, leB, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const created = await createParty(ctxAB, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Scoped Create Co",
    });
    const actor = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.PARTY_ASSIGNMENT_CREATE],
      [leA.id, leB.id],
      leB.id,
    );
    extraUsers.push(actor.id);
    partyApiAuth.userId = actor.id;
    const ok = await invokeLoose(
      assignmentsPost as unknown as LooseHandler,
      request(`${base}/party-assignments`, {
        method: "POST",
        json: { partyId: created.party.id, legalEntityId: leB.id },
      }),
      { tenantId },
    );
    expect(ok.status).toBe(201);
    const denied = await invokeLoose(
      assignmentsPost as unknown as LooseHandler,
      request(`${base}/party-assignments`, {
        method: "POST",
        json: {
          partyId: created.party.id,
          legalEntityId: leA.id,
          permissions: [PERMISSIONS.PARTY_ASSIGNMENT_CREATE],
        },
      }),
      { tenantId },
    );
    expect(denied.status).toBe(403);
  }, 60_000);

  it("requires tenant-wide permission for unfiltered list and id-derived assignment ops", async () => {
    fixture = await setupPartyDomainFixture();
    const { setup, leA, leB, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const created = await createParty(ctxAB, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Tenant Wide Co",
    });
    const extra = await createAssignment(ctxAB, {
      partyId: created.party.id,
      legalEntityId: leB.id,
    });
    const scoped = await createActor(
      tenantId,
      setup.adminUserId,
      [
        PERMISSIONS.PARTY_ASSIGNMENT_READ,
        PERMISSIONS.PARTY_ASSIGNMENT_UPDATE,
        PERMISSIONS.PARTY_ASSIGNMENT_REVOKE,
      ],
      [leA.id, leB.id],
      leA.id,
    );
    extraUsers.push(scoped.id);
    partyApiAuth.userId = scoped.id;
    expect(
      (
        await invokeLoose(
          assignmentsGet as unknown as LooseHandler,
          request(`${base}/party-assignments`),
          { tenantId },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          assignmentsGet as unknown as LooseHandler,
          request(`${base}/party-assignments?legalEntityId=${leA.id}`),
          { tenantId },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await invokeLoose(
          assignmentsGet as unknown as LooseHandler,
          request(`${base}/party-assignments?legalEntityId=${leB.id}`),
          { tenantId },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          assignmentGet as unknown as LooseHandler,
          request(`${base}/party-assignments/${created.assignment.id}`),
          { tenantId, assignmentId: created.assignment.id },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          assignmentPatch as unknown as LooseHandler,
          request(`${base}/party-assignments/${extra.id}`, {
            method: "PATCH",
            json: { expectedVersion: extra.version, status: "SUSPENDED" },
          }),
          { tenantId, assignmentId: extra.id },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeLoose(
          assignmentRevoke as unknown as LooseHandler,
          request(`${base}/party-assignments/${extra.id}/revoke`, {
            method: "POST",
            json: { expectedVersion: extra.version },
          }),
          { tenantId, assignmentId: extra.id },
        )
      ).status,
    ).toBe(403);
  }, 60_000);
});
