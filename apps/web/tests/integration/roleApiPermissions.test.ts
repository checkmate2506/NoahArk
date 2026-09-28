import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { PERMISSIONS } from "@noahark/authz";
import { createSystemClient } from "@noahark/db/system";
import { withTenantContext } from "@noahark/db";
import { createParty } from "@noahark/crm";
import {
  API_WRITE_TENANT,
  API_WRITE_TENANT_USER,
  apiWriteCanonicalKey,
  hashKey,
} from "@/lib/rateLimiter";
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

describe("P2D.2b customer and vendor role API permissions", () => {
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
      assignmentId: string;
      customerId: string;
      customerVersion: number;
      vendorId: string;
      vendorVersion: number;
    }) => {
      handler: LooseHandler;
      req: Request;
      params: { tenantId: string } & Record<string, string>;
    };
  }> = [
    {
      name: "POST /customer-roles",
      permission: PERMISSIONS.CUSTOMER_ROLE_CREATE,
      neighbor: PERMISSIONS.CUSTOMER_ROLE_UPDATE,
      success: 201,
      write: true,
      run: ({ base, tenantId, assignmentId }) => ({
        handler: customerCreate as unknown as LooseHandler,
        req: request(`${base}/customer-roles`, {
          method: "POST",
          json: {
            assignmentId,
            code: partyCode("C"),
            permissions: [PERMISSIONS.CUSTOMER_ROLE_CREATE],
            actingUserId: "forged",
            legalEntityIds: ["x"],
          },
        }),
        params: { tenantId },
      }),
    },
    {
      name: "GET /customer-roles/{id}",
      permission: PERMISSIONS.CUSTOMER_ROLE_READ,
      neighbor: PERMISSIONS.CUSTOMER_ROLE_UPDATE,
      success: 200,
      write: false,
      run: ({ base, tenantId, customerId }) => ({
        handler: customerGet as unknown as LooseHandler,
        req: request(`${base}/customer-roles/${customerId}`),
        params: { tenantId, roleId: customerId },
      }),
    },
    {
      name: "PATCH /customer-roles/{id}",
      permission: PERMISSIONS.CUSTOMER_ROLE_UPDATE,
      neighbor: PERMISSIONS.CUSTOMER_ROLE_ARCHIVE,
      success: 200,
      write: true,
      run: ({ base, tenantId, customerId, customerVersion }) => ({
        handler: customerPatch as unknown as LooseHandler,
        req: request(`${base}/customer-roles/${customerId}`, {
          method: "PATCH",
          json: { expectedVersion: customerVersion, status: "SUSPENDED" },
        }),
        params: { tenantId, roleId: customerId },
      }),
    },
    {
      name: "POST /customer-roles/{id}/archive",
      permission: PERMISSIONS.CUSTOMER_ROLE_ARCHIVE,
      neighbor: PERMISSIONS.CUSTOMER_ROLE_UPDATE,
      success: 200,
      write: true,
      run: ({ base, tenantId, customerId, customerVersion }) => ({
        handler: customerArchive as unknown as LooseHandler,
        req: request(`${base}/customer-roles/${customerId}/archive`, {
          method: "POST",
          json: { expectedVersion: customerVersion },
        }),
        params: { tenantId, roleId: customerId },
      }),
    },
    {
      name: "POST /vendor-roles",
      permission: PERMISSIONS.VENDOR_ROLE_CREATE,
      neighbor: PERMISSIONS.VENDOR_ROLE_UPDATE,
      success: 201,
      write: true,
      run: ({ base, tenantId, assignmentId }) => ({
        handler: vendorCreate as unknown as LooseHandler,
        req: request(`${base}/vendor-roles`, {
          method: "POST",
          json: {
            assignmentId,
            code: partyCode("V"),
            permissions: [PERMISSIONS.VENDOR_ROLE_CREATE],
          },
        }),
        params: { tenantId },
      }),
    },
    {
      name: "GET /vendor-roles/{id}",
      permission: PERMISSIONS.VENDOR_ROLE_READ,
      neighbor: PERMISSIONS.VENDOR_ROLE_UPDATE,
      success: 200,
      write: false,
      run: ({ base, tenantId, vendorId }) => ({
        handler: vendorGet as unknown as LooseHandler,
        req: request(`${base}/vendor-roles/${vendorId}`),
        params: { tenantId, roleId: vendorId },
      }),
    },
    {
      name: "PATCH /vendor-roles/{id}",
      permission: PERMISSIONS.VENDOR_ROLE_UPDATE,
      neighbor: PERMISSIONS.VENDOR_ROLE_ARCHIVE,
      success: 200,
      write: true,
      run: ({ base, tenantId, vendorId, vendorVersion }) => ({
        handler: vendorPatch as unknown as LooseHandler,
        req: request(`${base}/vendor-roles/${vendorId}`, {
          method: "PATCH",
          json: { expectedVersion: vendorVersion, status: "SUSPENDED" },
        }),
        params: { tenantId, roleId: vendorId },
      }),
    },
    {
      name: "POST /vendor-roles/{id}/archive",
      permission: PERMISSIONS.VENDOR_ROLE_ARCHIVE,
      neighbor: PERMISSIONS.VENDOR_ROLE_UPDATE,
      success: 200,
      write: true,
      run: ({ base, tenantId, vendorId, vendorVersion }) => ({
        handler: vendorArchive as unknown as LooseHandler,
        req: request(`${base}/vendor-roles/${vendorId}/archive`, {
          method: "POST",
          json: { expectedVersion: vendorVersion },
        }),
        params: { tenantId, roleId: vendorId },
      }),
    },
  ];

  it("grants only the exact tenant-wide key for each role operation", async () => {
    fixture = await setupPartyDomainFixture();
    const { setup, leA, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    for (const op of matrix) {
      const seeded = await createParty(ctxAB, {
        ownerLegalEntityId: leA.id,
        code: partyCode(),
        partyType: "ORGANISATION",
        legalName: `Role Perm ${op.name}`,
        customerRole: { code: partyCode("C") },
        vendorRole: { code: partyCode("V") },
      });
      const actor = await createActor(
        tenantId,
        setup.adminUserId,
        [op.permission],
        [leA.id],
      );
      extraUsers.push(actor.id);
      partyApiAuth.userId = actor.id;
      const createOp =
        op.name.startsWith("POST /customer-roles") && !op.name.includes("{id}");
      const createVendorOp =
        op.name.startsWith("POST /vendor-roles") && !op.name.includes("{id}");
      const fresh =
        createOp || createVendorOp
          ? await createParty(ctxAB, {
              ownerLegalEntityId: leA.id,
              code: partyCode(),
              partyType: "ORGANISATION",
              legalName: `Fresh ${op.name}`,
            })
          : seeded;
      const resolved = op.run({
        base,
        tenantId,
        assignmentId: fresh.assignment.id,
        customerId: seeded.customerRole!.id,
        customerVersion: seeded.customerRole!.version,
        vendorId: seeded.vendorRole!.id,
        vendorVersion: seeded.vendorRole!.version,
      });
      expect(
        (await invokeLoose(resolved.handler, resolved.req, resolved.params)).status,
        op.name,
      ).toBe(op.success);
    }
  }, 120_000);

  it("rejects missing, neighbouring and entity-scoped role permissions without consuming writes", async () => {
    fixture = await setupPartyDomainFixture();
    const { setup, leA, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const seeded = await createParty(ctxAB, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Role Denied Co",
      customerRole: { code: partyCode("C") },
      vendorRole: { code: partyCode("V") },
    });
    const snapshot = () =>
      withTenantContext(
        { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
        async (tx) => ({
          customers: await tx.customerRole.count({ where: { tenantId } }),
          vendors: await tx.vendorRole.count({ where: { tenantId } }),
          audits: await tx.auditEvent.count({ where: { tenantId } }),
        }),
      );
    for (const op of matrix) {
      const none = await createActor(tenantId, setup.adminUserId, [], [leA.id]);
      extraUsers.push(none.id);
      const neighbor = await createActor(
        tenantId,
        setup.adminUserId,
        [op.neighbor],
        [leA.id],
      );
      extraUsers.push(neighbor.id);
      const scoped = await createActor(
        tenantId,
        setup.adminUserId,
        [op.permission],
        [leA.id],
        leA.id,
      );
      extraUsers.push(scoped.id);
      const call = op.run({
        base,
        tenantId,
        assignmentId: seeded.assignment.id,
        customerId: seeded.customerRole!.id,
        customerVersion: seeded.customerRole!.version,
        vendorId: seeded.vendorRole!.id,
        vendorVersion: seeded.vendorRole!.version,
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
      partyApiAuth.userId = scoped.id;
      expect(
        (await invokeLoose(call.handler, call.req.clone(), call.params)).status,
        `${op.name} entity-scoped`,
      ).toBe(403);
      expect(await snapshot(), `${op.name} snapshot`).toEqual(before);
      if (op.write) {
        expect(await writeBucketCounts(tenantId, none.id)).toEqual(beforeBuckets);
      }
    }
  }, 120_000);
});
