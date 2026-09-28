import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { PERMISSIONS } from "@noahark/authz";
import { createSystemClient } from "@noahark/db/system";
import { withTenantContext } from "@noahark/db";
import { createAssignment, createParty } from "@noahark/crm";
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
  createTestLegalEntity,
  createTestUser,
  grantLegalEntityAccessDirect,
  setupTestTenant,
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

async function invoke<P extends { tenantId: string }>(
  handler: (req: Request, ctx: { params: Promise<P> }) => Promise<Response>,
  req: Request,
  params: P,
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

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function errorCode(body: Record<string, unknown>): string {
  return (body.error as { code: string }).code;
}

async function createActor(
  tenantId: string,
  adminUserId: string,
  keys: string[],
  legalEntityIds: string[],
) {
  const user = await createTestUser();
  const mem = await addTenantMember(tenantId, user.id);
  const db = createSystemClient();
  const permissions = await db.permission.findMany({ where: { key: { in: keys } } });
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
  await assignRoleDirect(tenantId, mem.id, role.id, adminUserId, null);
  for (const legalEntityId of legalEntityIds) {
    await grantLegalEntityAccessDirect(tenantId, legalEntityId, user.id);
  }
  return user;
}

describe("P2D.2b assignment API isolation", () => {
  let fixture: PartyDomainFixture | undefined;
  let other: Awaited<ReturnType<typeof setupTestTenant>> | undefined;
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
    if (other) {
      await cleanupTenant(other.tenantId).catch(() => undefined);
      await cleanupUser(other.adminUserId).catch(() => undefined);
      other = undefined;
    }
  });

  it("hides out-of-scope and cross-tenant assignment ids as NOT_FOUND", async () => {
    fixture = await setupPartyDomainFixture();
    const { setup, leA, leB, leId, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    partyApiAuth.userId = setup.adminUserId;
    const created = await createParty(ctxAB, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Iso Assign Co",
    });
    await createAssignment(ctxAB, {
      partyId: created.party.id,
      legalEntityId: leB.id,
    });

    const outOfScope = await createActor(
      tenantId,
      setup.adminUserId,
      [
        PERMISSIONS.PARTY_ASSIGNMENT_READ,
        PERMISSIONS.PARTY_ASSIGNMENT_UPDATE,
        PERMISSIONS.PARTY_ASSIGNMENT_REVOKE,
        PERMISSIONS.PARTY_ASSIGNMENT_CREATE,
      ],
      [leId.id],
    );
    extraUsers.push(outOfScope.id);
    other = await setupTestTenant();
    const otherLe = await createTestLegalEntity(other.tenantId, "SG");
    await grantLegalEntityAccessDirect(other.tenantId, otherLe.id, other.adminUserId);

    const snapshot = () =>
      withTenantContext(
        { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
        async (tx) => ({
          assignments: await tx.partyLegalEntityAssignment.count({ where: { tenantId } }),
          audits: await tx.auditEvent.count({ where: { tenantId } }),
        }),
      );

    function opaqueShape(body: Record<string, unknown>) {
      const error = body.error as { code: string; message: string; details: unknown };
      return {
        code: error.code,
        message: error.message,
        detailsType: error.details == null ? "empty" : typeof error.details,
      };
    }

    const ops = [
      {
        id: "get",
        run: (tid: string, assignmentId: string) =>
          invoke(
            assignmentGet,
            request(
              `https://noahark.example/api/v1/tenants/${tid}/party-assignments/${assignmentId}`,
            ),
            { tenantId: tid, assignmentId },
          ),
      },
      {
        id: "patch",
        run: (tid: string, assignmentId: string) =>
          invoke(
            assignmentPatch,
            request(
              `https://noahark.example/api/v1/tenants/${tid}/party-assignments/${assignmentId}`,
              { method: "PATCH", json: { expectedVersion: 1, status: "SUSPENDED" } },
            ),
            { tenantId: tid, assignmentId },
          ),
      },
      {
        id: "revoke",
        run: (tid: string, assignmentId: string) =>
          invoke(
            assignmentRevoke,
            request(
              `https://noahark.example/api/v1/tenants/${tid}/party-assignments/${assignmentId}/revoke`,
              { method: "POST", json: { expectedVersion: 1 } },
            ),
            { tenantId: tid, assignmentId },
          ),
      },
    ];

    const before = await snapshot();
    for (const op of ops) {
      partyApiAuth.userId = outOfScope.id;
      const hidden = await op.run(tenantId, created.assignment.id);
      const hiddenBody = await readJson(hidden);
      expect(hidden.status, op.id).toBe(404);
      expect(errorCode(hiddenBody)).toBe("NOT_FOUND");
      expect(JSON.stringify(hiddenBody)).not.toContain(tenantId);
      expect(JSON.stringify(hiddenBody)).not.toMatch(/"version"\s*:/);

      partyApiAuth.userId = other.adminUserId;
      const cross = await op.run(other.tenantId, created.assignment.id);
      const crossBody = await readJson(cross);
      const missing = await op.run(other.tenantId, "does-not-exist");
      const missingBody = await readJson(missing);
      expect(cross.status).toBe(404);
      expect(opaqueShape(crossBody)).toEqual(opaqueShape(missingBody));
      expect(JSON.stringify(crossBody)).not.toContain(tenantId);
    }
    expect(await snapshot()).toEqual(before);

    partyApiAuth.userId = setup.adminUserId;
    const forged = await invoke(
      assignmentsGet,
      request(
        `https://noahark.example/api/v1/tenants/${other.tenantId}/party-assignments`,
      ),
      { tenantId: other.tenantId },
    );
    expect(forged.status).toBe(403);

    partyApiAuth.userId = setup.adminUserId;
    const widenFilter = await invoke(
      assignmentsGet,
      request(`${base}/party-assignments?legalEntityId=${leId.id}`),
      { tenantId },
    );
    expect(widenFilter.status).toBe(403);

    const empty = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.PARTY_ASSIGNMENT_READ],
      [],
    );
    extraUsers.push(empty.id);
    partyApiAuth.userId = empty.id;
    expect(
      (await invoke(assignmentsGet, request(`${base}/party-assignments`), { tenantId }))
        .status,
    ).toBe(403);

    partyApiAuth.userId = outOfScope.id;
    const widen = await invoke(
      assignmentsPost,
      request(`${base}/party-assignments`, {
        method: "POST",
        json: {
          partyId: created.party.id,
          legalEntityId: leA.id,
          legalEntityIds: [leA.id],
        },
      }),
      { tenantId },
    );
    expect(widen.status).toBe(403);
    expect(await snapshot()).toEqual(before);
  }, 60_000);
});
