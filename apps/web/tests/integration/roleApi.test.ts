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

type RoleRow = {
  id: string;
  version: number;
  status: string;
  code: string;
  defaultCurrency: string | null;
  assignmentId: string;
};

function roleFrom(
  body: Record<string, unknown>,
  key: "customerRole" | "vendorRole",
): RoleRow {
  const role = (body.data as Record<string, RoleRow | undefined>)[key];
  if (!role) throw new Error(`missing ${key}`);
  return role;
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

describe("P2D.2b customer and vendor role APIs", () => {
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

  it("covers role CRUD, uniqueness, snapshots, CSRF, audit and nested OpenAPI", async () => {
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
      legalName: "Role Api Co",
    });
    const other = await createParty(ctxAB, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Role Other Co",
    });
    const otherLe = await createAssignment(ctxAB, {
      partyId: created.party.id,
      legalEntityId: leB.id,
    });
    const partyBefore = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) =>
        tx.party.findFirstOrThrow({
          where: { id: created.party.id },
          select: { version: true, legalName: true, ownerLegalEntityId: true },
        }),
    );
    const assignmentBefore = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) =>
        tx.partyLegalEntityAssignment.findFirstOrThrow({
          where: { id: created.assignment.id },
          select: { version: true, status: true, legalEntityId: true },
        }),
    );

    const custRequestId = uniqueSlug("rid");
    const beforeBuckets = await writeBucketCounts(tenantId, userId);
    const custCreate = await invoke(
      customerCreate,
      request(`${base}/customer-roles`, {
        method: "POST",
        headers: { "x-request-id": custRequestId },
        json: {
          assignmentId: created.assignment.id,
          code: partyCode("C"),
          defaultCurrency: "SGD",
          actingUserId: "forged-user",
          requestId: "forged-rid",
          tenantId: "forged-tenant",
          permissions: ["customer_role:create"],
        },
      }),
      { tenantId },
    );
    expect(custCreate.status).toBe(201);
    const custCreateBody = await readJson(custCreate);
    assertMatchesOpenApi("createCustomerRole", custCreateBody, ["customerRole"]);
    const customer = roleFrom(custCreateBody, "customerRole");
    expect(customer.defaultCurrency).toBe("SGD");
    expect(customer.assignmentId).toBe(created.assignment.id);
    expect(await writeBucketCounts(tenantId, userId)).toEqual({
      user: beforeBuckets.user + 1,
      tenant: beforeBuckets.tenant + 1,
    });

    const vendCreate = await invoke(
      vendorCreate,
      request(`${base}/vendor-roles`, {
        method: "POST",
        json: { assignmentId: created.assignment.id, code: partyCode("V") },
      }),
      { tenantId },
    );
    expect(vendCreate.status).toBe(201);
    const vendCreateBody = await readJson(vendCreate);
    assertMatchesOpenApi("createVendorRole", vendCreateBody, ["vendorRole"]);
    const vendor = roleFrom(vendCreateBody, "vendorRole");
    expect(vendor.defaultCurrency).toBeNull();

    expect(
      (
        await invoke(customerGet, request(`${base}/customer-roles/${customer.id}`), {
          tenantId,
          roleId: customer.id,
        })
      ).status,
    ).toBe(200);
    assertMatchesOpenApi(
      "getCustomerRole",
      await readJson(
        await invoke(customerGet, request(`${base}/customer-roles/${customer.id}`), {
          tenantId,
          roleId: customer.id,
        }),
      ),
      ["customerRole"],
    );
    assertMatchesOpenApi(
      "getVendorRole",
      await readJson(
        await invoke(vendorGet, request(`${base}/vendor-roles/${vendor.id}`), {
          tenantId,
          roleId: vendor.id,
        }),
      ),
      ["vendorRole"],
    );

    const custPatched = await invoke(
      customerPatch,
      request(`${base}/customer-roles/${customer.id}`, {
        method: "PATCH",
        json: {
          expectedVersion: customer.version,
          code: partyCode("C2"),
          defaultCurrency: null,
        },
      }),
      { tenantId, roleId: customer.id },
    );
    expect(custPatched.status).toBe(200);
    const custPatchedBody = await readJson(custPatched);
    assertMatchesOpenApi("updateCustomerRole", custPatchedBody, ["customerRole"]);
    const customerUpdated = roleFrom(custPatchedBody, "customerRole");
    expect(customerUpdated.defaultCurrency).toBeNull();

    const vendPatched = await invoke(
      vendorPatch,
      request(`${base}/vendor-roles/${vendor.id}`, {
        method: "PATCH",
        json: { expectedVersion: vendor.version, status: "SUSPENDED" },
      }),
      { tenantId, roleId: vendor.id },
    );
    expect(vendPatched.status).toBe(200);
    const vendPatchedBody = await readJson(vendPatched);
    assertMatchesOpenApi("updateVendorRole", vendPatchedBody, ["vendorRole"]);
    const vendorUpdated = roleFrom(vendPatchedBody, "vendorRole");

    const auditsBeforeDup = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) => tx.auditEvent.count({ where: { tenantId } }),
    );
    const dupRole = await invoke(
      customerCreate,
      request(`${base}/customer-roles`, {
        method: "POST",
        json: { assignmentId: created.assignment.id, code: partyCode("C") },
      }),
      { tenantId },
    );
    expect(dupRole.status).toBe(409);
    expect(errorCode(await readJson(dupRole))).toBe("CONFLICT");
    expect(
      await withTenantContext(
        { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
        (tx) => tx.auditEvent.count({ where: { tenantId } }),
      ),
    ).toBe(auditsBeforeDup);

    const sharedCode = partyCode("X");
    const dupCustCode = await invoke(
      customerCreate,
      request(`${base}/customer-roles`, {
        method: "POST",
        json: { assignmentId: other.assignment.id, code: customerUpdated.code },
      }),
      { tenantId },
    );
    expect(dupCustCode.status).toBe(409);
    const firstVendOnOther = await invoke(
      vendorCreate,
      request(`${base}/vendor-roles`, {
        method: "POST",
        json: { assignmentId: other.assignment.id, code: vendorUpdated.code },
      }),
      { tenantId },
    );
    expect(firstVendOnOther.status).toBe(409);

    const crossRoleOk = await invoke(
      customerCreate,
      request(`${base}/customer-roles`, {
        method: "POST",
        json: { assignmentId: otherLe.id, code: customerUpdated.code },
      }),
      { tenantId },
    );
    expect(crossRoleOk.status).toBe(201);
    const vendorSameCode = await invoke(
      vendorCreate,
      request(`${base}/vendor-roles`, {
        method: "POST",
        json: { assignmentId: other.assignment.id, code: customerUpdated.code },
      }),
      { tenantId },
    );
    expect(vendorSameCode.status).toBe(201);
    const sharedCustomer = await invoke(
      customerCreate,
      request(`${base}/customer-roles`, {
        method: "POST",
        json: { assignmentId: other.assignment.id, code: sharedCode },
      }),
      { tenantId },
    );
    expect(sharedCustomer.status).toBe(201);

    expect(
      (
        await invoke(
          customerCreate,
          request(`${base}/customer-roles`, {
            method: "POST",
            json: {
              assignmentId: created.assignment.id,
              code: partyCode("C"),
              defaultCurrency: "USD",
            },
          }),
          { tenantId },
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await invoke(
          vendorCreate,
          request(`${base}/vendor-roles`, {
            method: "POST",
            json: {
              assignmentId: created.assignment.id,
              code: partyCode("V"),
              defaultCurrency: null,
            },
          }),
          { tenantId },
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await invoke(
          customerCreate,
          new Request(`${base}/customer-roles`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-request-id": uniqueSlug("rid"),
            },
            body: "{",
          }),
          { tenantId },
        )
      ).status,
    ).toBe(422);

    const stale = await invoke(
      customerPatch,
      request(`${base}/customer-roles/${customer.id}`, {
        method: "PATCH",
        json: { expectedVersion: 1, code: partyCode("C3") },
      }),
      { tenantId, roleId: customer.id },
    );
    expect(stale.status).toBe(409);
    expect(errorCode(await readJson(stale))).toBe("STALE_VERSION");

    const csrfBefore = await writeBucketCounts(tenantId, userId);
    const csrfState = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        customers: await tx.customerRole.count({ where: { tenantId } }),
        vendors: await tx.vendorRole.count({ where: { tenantId } }),
        audits: await tx.auditEvent.count({ where: { tenantId } }),
      }),
    );
    const csrfCustomer = await invoke(
      customerArchive,
      request(`${base}/customer-roles/${customer.id}/archive`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        json: { expectedVersion: customerUpdated.version },
      }),
      { tenantId, roleId: customer.id },
    );
    const csrfVendor = await invoke(
      vendorArchive,
      request(`${base}/vendor-roles/${vendor.id}/archive`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        json: { expectedVersion: vendorUpdated.version },
      }),
      { tenantId, roleId: vendor.id },
    );
    expect(csrfCustomer.status).toBe(403);
    expect(csrfVendor.status).toBe(403);
    expect(await writeBucketCounts(tenantId, userId)).toEqual(csrfBefore);
    expect(
      await withTenantContext(
        { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
        async (tx) => ({
          customers: await tx.customerRole.count({ where: { tenantId } }),
          vendors: await tx.vendorRole.count({ where: { tenantId } }),
          audits: await tx.auditEvent.count({ where: { tenantId } }),
        }),
      ),
    ).toEqual(csrfState);

    expect(
      (
        await invoke(
          customerArchive,
          request(`${base}/customer-roles/${customer.id}/archive`, {
            method: "POST",
            json: { expectedVersion: customerUpdated.version, extra: true },
          }),
          { tenantId, roleId: customer.id },
        )
      ).status,
    ).toBe(422);

    const archivedCust = await invoke(
      customerArchive,
      request(`${base}/customer-roles/${customer.id}/archive`, {
        method: "POST",
        json: { expectedVersion: customerUpdated.version },
      }),
      { tenantId, roleId: customer.id },
    );
    expect(archivedCust.status).toBe(200);
    const archivedCustBody = await readJson(archivedCust);
    assertMatchesOpenApi("archiveCustomerRole", archivedCustBody, ["customerRole"]);
    expect(roleFrom(archivedCustBody, "customerRole").status).toBe("ARCHIVED");

    const archivedVend = await invoke(
      vendorArchive,
      request(`${base}/vendor-roles/${vendor.id}/archive`, {
        method: "POST",
        json: { expectedVersion: vendorUpdated.version },
      }),
      { tenantId, roleId: vendor.id },
    );
    expect(archivedVend.status).toBe(200);
    const archivedVendBody = await readJson(archivedVend);
    assertMatchesOpenApi("archiveVendorRole", archivedVendBody, ["vendorRole"]);
    expect(roleFrom(archivedVendBody, "vendorRole").status).toBe("ARCHIVED");

    expect(
      (
        await invoke(
          customerPatch,
          request(`${base}/customer-roles/${customer.id}`, {
            method: "PATCH",
            json: {
              expectedVersion: roleFrom(archivedCustBody, "customerRole").version,
              code: partyCode("C4"),
            },
          }),
          { tenantId, roleId: customer.id },
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await invoke(
          customerArchive,
          request(`${base}/customer-roles/${customer.id}/archive`, {
            method: "POST",
            json: { expectedVersion: roleFrom(archivedCustBody, "customerRole").version },
          }),
          { tenantId, roleId: customer.id },
        )
      ).status,
    ).toBe(422);

    const partyAfter = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) =>
        tx.party.findFirstOrThrow({
          where: { id: created.party.id },
          select: { version: true, legalName: true, ownerLegalEntityId: true },
        }),
    );
    const assignmentAfter = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) =>
        tx.partyLegalEntityAssignment.findFirstOrThrow({
          where: { id: created.assignment.id },
          select: { version: true, status: true, legalEntityId: true },
        }),
    );
    expect(partyAfter).toEqual(partyBefore);
    expect(assignmentAfter).toEqual(assignmentBefore);

    const audits = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) =>
        tx.auditEvent.findMany({ where: { tenantId }, orderBy: { sequence: "asc" } }),
    );
    expect(verifyAuditChain(toLinks(audits)).valid).toBe(true);
    const createdAudit = audits.find(
      (a) =>
        a.action === AUDIT_ACTIONS.CUSTOMER_ROLE_CREATED && a.entityId === customer.id,
    );
    expect(createdAudit?.actorUserId).toBe(userId);
    expect(createdAudit?.requestId).toBe(custRequestId);
    expect(
      JSON.stringify(audits, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toContain("forged-user");
    expect(audits.some((a) => a.action === AUDIT_ACTIONS.CUSTOMER_ROLE_UPDATED)).toBe(
      true,
    );
    expect(audits.some((a) => a.action === AUDIT_ACTIONS.CUSTOMER_ROLE_ARCHIVED)).toBe(
      true,
    );
    expect(audits.some((a) => a.action === AUDIT_ACTIONS.VENDOR_ROLE_CREATED)).toBe(true);
    expect(audits.some((a) => a.action === AUDIT_ACTIONS.VENDOR_ROLE_UPDATED)).toBe(true);
    expect(audits.some((a) => a.action === AUDIT_ACTIONS.VENDOR_ROLE_ARCHIVED)).toBe(
      true,
    );

    const roleSchema = OPENAPI_DOC.components?.schemas?.PartyRole;
    const broken: OpenApiSchema = {
      ...roleSchema!,
      properties: {
        ...roleSchema!.properties,
        defaultCurrency: { type: "string", enum: ["USD"] },
      },
    };
    expect(
      validateOpenApiValue(
        OPENAPI_DOC,
        broken,
        roleFrom(custCreateBody, "customerRole"),
        "broken-role",
      ).some((error) => error.includes("enum")),
    ).toBe(true);
  }, 120_000);
});
