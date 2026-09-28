import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { PERMISSIONS } from "@noahark/authz";
import { createSystemClient } from "@noahark/db/system";
import { withTenantContext } from "@noahark/db";
import { createAssignment, createParty } from "@noahark/crm";
import { POST as customerCreate } from "@/app/api/v1/tenants/[tenantId]/customer-roles/route";
import {
  GET as customerGet,
  PATCH as customerPatch,
} from "@/app/api/v1/tenants/[tenantId]/customer-roles/[roleId]/route";
import { POST as customerArchive } from "@/app/api/v1/tenants/[tenantId]/customer-roles/[roleId]/archive/route";
import { POST as vendorCreate } from "@/app/api/v1/tenants/[tenantId]/vendor-roles/route";
import {
  GET as vendorGet,
  PATCH as vendorPatch,
} from "@/app/api/v1/tenants/[tenantId]/vendor-roles/[roleId]/route";
import { POST as vendorArchive } from "@/app/api/v1/tenants/[tenantId]/vendor-roles/[roleId]/archive/route";
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

describe("P2D.2b customer and vendor role API isolation", () => {
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

  it("hides out-of-scope and cross-tenant role ids as NOT_FOUND", async () => {
    fixture = await setupPartyDomainFixture();
    const { setup, leA, leB, leId, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const seeded = await createParty(ctxAB, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Role Iso Co",
      customerRole: { code: partyCode("C") },
      vendorRole: { code: partyCode("V") },
    });
    const bAssign = await createAssignment(ctxAB, {
      partyId: seeded.party.id,
      legalEntityId: leB.id,
    });
    const outOfScope = await createActor(
      tenantId,
      setup.adminUserId,
      [
        PERMISSIONS.CUSTOMER_ROLE_READ,
        PERMISSIONS.CUSTOMER_ROLE_CREATE,
        PERMISSIONS.CUSTOMER_ROLE_UPDATE,
        PERMISSIONS.CUSTOMER_ROLE_ARCHIVE,
        PERMISSIONS.VENDOR_ROLE_READ,
        PERMISSIONS.VENDOR_ROLE_CREATE,
        PERMISSIONS.VENDOR_ROLE_UPDATE,
        PERMISSIONS.VENDOR_ROLE_ARCHIVE,
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
          customers: await tx.customerRole.count({ where: { tenantId } }),
          vendors: await tx.vendorRole.count({ where: { tenantId } }),
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
        id: "customer-get",
        run: (tid: string, roleId: string) =>
          invoke(
            customerGet,
            request(
              `https://noahark.example/api/v1/tenants/${tid}/customer-roles/${roleId}`,
            ),
            {
              tenantId: tid,
              roleId,
            },
          ),
      },
      {
        id: "customer-patch",
        run: (tid: string, roleId: string) =>
          invoke(
            customerPatch,
            request(
              `https://noahark.example/api/v1/tenants/${tid}/customer-roles/${roleId}`,
              {
                method: "PATCH",
                json: { expectedVersion: 1, code: partyCode("C") },
              },
            ),
            { tenantId: tid, roleId },
          ),
      },
      {
        id: "customer-archive",
        run: (tid: string, roleId: string) =>
          invoke(
            customerArchive,
            request(
              `https://noahark.example/api/v1/tenants/${tid}/customer-roles/${roleId}/archive`,
              {
                method: "POST",
                json: { expectedVersion: 1 },
              },
            ),
            { tenantId: tid, roleId },
          ),
      },
      {
        id: "vendor-get",
        run: (tid: string, roleId: string) =>
          invoke(
            vendorGet,
            request(
              `https://noahark.example/api/v1/tenants/${tid}/vendor-roles/${roleId}`,
            ),
            {
              tenantId: tid,
              roleId,
            },
          ),
      },
      {
        id: "vendor-patch",
        run: (tid: string, roleId: string) =>
          invoke(
            vendorPatch,
            request(
              `https://noahark.example/api/v1/tenants/${tid}/vendor-roles/${roleId}`,
              {
                method: "PATCH",
                json: { expectedVersion: 1, code: partyCode("V") },
              },
            ),
            { tenantId: tid, roleId },
          ),
      },
      {
        id: "vendor-archive",
        run: (tid: string, roleId: string) =>
          invoke(
            vendorArchive,
            request(
              `https://noahark.example/api/v1/tenants/${tid}/vendor-roles/${roleId}/archive`,
              {
                method: "POST",
                json: { expectedVersion: 1 },
              },
            ),
            { tenantId: tid, roleId },
          ),
      },
    ];

    const before = await snapshot();
    for (const op of ops) {
      const roleId = op.id.startsWith("vendor")
        ? seeded.vendorRole!.id
        : seeded.customerRole!.id;
      partyApiAuth.userId = outOfScope.id;
      const hidden = await op.run(tenantId, roleId);
      const hiddenBody = await readJson(hidden);
      expect(hidden.status, op.id).toBe(404);
      expect(errorCode(hiddenBody)).toBe("NOT_FOUND");
      expect(JSON.stringify(hiddenBody)).not.toContain(tenantId);
      expect(JSON.stringify(hiddenBody)).not.toMatch(/"version"\s*:/);

      partyApiAuth.userId = other.adminUserId;
      const cross = await op.run(other.tenantId, roleId);
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
      customerGet,
      request(
        `https://noahark.example/api/v1/tenants/${other.tenantId}/customer-roles/${seeded.customerRole!.id}`,
      ),
      { tenantId: other.tenantId, roleId: seeded.customerRole!.id },
    );
    expect(forged.status).toBe(403);

    const empty = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.CUSTOMER_ROLE_READ, PERMISSIONS.VENDOR_ROLE_READ],
      [],
    );
    extraUsers.push(empty.id);
    partyApiAuth.userId = empty.id;
    expect(
      (
        await invoke(
          customerGet,
          request(`${base}/customer-roles/${seeded.customerRole!.id}`),
          { tenantId, roleId: seeded.customerRole!.id },
        )
      ).status,
    ).toBe(403);

    partyApiAuth.userId = outOfScope.id;
    const widen = await invoke(
      customerCreate,
      request(`${base}/customer-roles`, {
        method: "POST",
        json: {
          assignmentId: seeded.assignment.id,
          code: partyCode("C"),
          legalEntityIds: [leA.id],
        },
      }),
      { tenantId },
    );
    expect(widen.status).toBe(404);

    const scopedA = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.CUSTOMER_ROLE_CREATE, PERMISSIONS.VENDOR_ROLE_CREATE],
      [leA.id],
    );
    extraUsers.push(scopedA.id);
    partyApiAuth.userId = scopedA.id;
    const beforeReject = await snapshot();
    const crossEntityAsA = await invoke(
      customerCreate,
      request(`${base}/customer-roles`, {
        method: "POST",
        json: { assignmentId: bAssign.id, code: partyCode("C") },
      }),
      { tenantId },
    );
    expect(crossEntityAsA.status).toBe(404);
    expect(errorCode(await readJson(crossEntityAsA))).toBe("NOT_FOUND");
    const vendorCross = await invoke(
      vendorCreate,
      request(`${base}/vendor-roles`, {
        method: "POST",
        json: { assignmentId: bAssign.id, code: partyCode("V") },
      }),
      { tenantId },
    );
    expect(vendorCross.status).toBe(404);
    expect(await snapshot()).toEqual(beforeReject);

    partyApiAuth.userId = setup.adminUserId;
    const inScope = await invoke(
      customerCreate,
      request(`${base}/customer-roles`, {
        method: "POST",
        json: { assignmentId: bAssign.id, code: partyCode("C") },
      }),
      { tenantId },
    );
    expect(inScope.status).toBe(201);
  }, 60_000);
});
