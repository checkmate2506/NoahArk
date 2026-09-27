import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { PERMISSIONS } from "@noahark/authz";
import { createSystemClient } from "@noahark/db/system";
import { withTenantContext } from "@noahark/db";
import { createAssignment } from "@noahark/crm";
import {
  API_WRITE_TENANT,
  API_WRITE_TENANT_USER,
  apiWriteCanonicalKey,
  hashKey,
} from "@/lib/rateLimiter";
import {
  GET as listCreateGet,
  POST as listCreatePost,
} from "@/app/api/v1/tenants/[tenantId]/parties/route";
import {
  GET as partyGet,
  PATCH as partyPatch,
} from "@/app/api/v1/tenants/[tenantId]/parties/[partyId]/route";
import { POST as partyArchive } from "@/app/api/v1/tenants/[tenantId]/parties/[partyId]/archive/route";
import { POST as partyTransfer } from "@/app/api/v1/tenants/[tenantId]/parties/[partyId]/ownership-transfer/route";
import { POST as duplicatePost } from "@/app/api/v1/tenants/[tenantId]/parties/duplicate-candidates/route";
import {
  GET as contactsGet,
  POST as contactsPost,
} from "@/app/api/v1/tenants/[tenantId]/parties/[partyId]/contacts/route";
import {
  GET as contactGet,
  PATCH as contactPatch,
} from "@/app/api/v1/tenants/[tenantId]/party-contacts/[contactId]/route";
import { POST as contactArchive } from "@/app/api/v1/tenants/[tenantId]/party-contacts/[contactId]/archive/route";
import {
  GET as addressesGet,
  POST as addressesPost,
} from "@/app/api/v1/tenants/[tenantId]/parties/[partyId]/addresses/route";
import {
  GET as addressGet,
  PATCH as addressPatch,
} from "@/app/api/v1/tenants/[tenantId]/party-addresses/[addressId]/route";
import { POST as addressArchive } from "@/app/api/v1/tenants/[tenantId]/party-addresses/[addressId]/archive/route";
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

async function invoke<P extends { tenantId: string }>(
  handler: (req: Request, ctx: { params: Promise<P> }) => Promise<Response>,
  req: Request,
  params: P,
): Promise<Response> {
  return handler(req, { params: Promise.resolve(params) });
}

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

async function createActor(
  tenantId: string,
  adminUserId: string,
  keys: string[],
  legalEntityIds: string[],
  scopedLegalEntityId: string | null = null,
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
  await assignRoleDirect(tenantId, mem.id, role.id, adminUserId, scopedLegalEntityId);
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

describe("P2D.2a party API permissions", () => {
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

  async function seed() {
    fixture = await setupPartyDomainFixture();
    partyApiAuth.userId = fixture.setup.adminUserId;
    const { setup, leA, leB, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const createdRes = await invoke(
      listCreatePost,
      request(`${base}/parties`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: partyCode(),
          partyType: "ORGANISATION",
          legalName: "Perm Co",
        },
      }),
      { tenantId },
    );
    const created = (
      (await readJson(createdRes)).data as { party: { id: string; version: number } }
    ).party;
    await createAssignment(ctxAB, { partyId: created.id, legalEntityId: leB.id });
    const contactRes = await invoke(
      contactsPost,
      request(`${base}/parties/${created.id}/contacts`, {
        method: "POST",
        json: { givenName: "Pat" },
      }),
      { tenantId, partyId: created.id },
    );
    const contact = (
      (await readJson(contactRes)).data as { contact: { id: string; version: number } }
    ).contact;
    const addressRes = await invoke(
      addressesPost,
      request(`${base}/parties/${created.id}/addresses`, {
        method: "POST",
        json: { addressType: "GENERAL", line1: "1 Street", countryCode: "SG" },
      }),
      { tenantId, partyId: created.id },
    );
    const address = (
      (await readJson(addressRes)).data as { address: { id: string; version: number } }
    ).address;
    return { fixture, created, contact, address, base, tenantId };
  }

  const matrix: Array<{
    name: string;
    permission: string;
    neighbor: string;
    legalEntities: "A" | "AB";
    run: (input: {
      base: string;
      tenantId: string;
      created: { id: string; version: number };
      contact: { id: string; version: number };
      address: { id: string; version: number };
      leA: string;
      leB: string;
    }) => Promise<{
      handler: LooseHandler;
      req: Request;
      params: { tenantId: string } & Record<string, string>;
    }>;
    success: number;
  }> = [
    {
      name: "GET /parties",
      permission: PERMISSIONS.PARTY_READ,
      neighbor: PERMISSIONS.PARTY_CREATE,
      legalEntities: "A",
      success: 200,
      run: async ({ base, tenantId }) => ({
        handler: listCreateGet as unknown as LooseHandler,
        req: request(`${base}/parties`),
        params: { tenantId },
      }),
    },
    {
      name: "POST /parties",
      permission: PERMISSIONS.PARTY_CREATE,
      neighbor: PERMISSIONS.PARTY_UPDATE,
      legalEntities: "A",
      success: 201,
      run: async ({ base, tenantId, leA }) => ({
        handler: listCreatePost as unknown as LooseHandler,
        req: request(`${base}/parties`, {
          method: "POST",
          json: {
            ownerLegalEntityId: leA,
            code: partyCode(),
            partyType: "ORGANISATION",
            legalName: "Created By Key",
            permissions: [PERMISSIONS.PARTY_CREATE],
          },
        }),
        params: { tenantId },
      }),
    },
    {
      name: "GET /parties/{id}",
      permission: PERMISSIONS.PARTY_READ,
      neighbor: PERMISSIONS.PARTY_UPDATE,
      legalEntities: "A",
      success: 200,
      run: async ({ base, tenantId, created }) => ({
        handler: partyGet as unknown as LooseHandler,
        req: request(`${base}/parties/${created.id}`),
        params: { tenantId, partyId: created.id },
      }),
    },
    {
      name: "PATCH /parties/{id}",
      permission: PERMISSIONS.PARTY_UPDATE,
      neighbor: PERMISSIONS.PARTY_ARCHIVE,
      legalEntities: "A",
      success: 200,
      run: async ({ base, tenantId, created }) => ({
        handler: partyPatch as unknown as LooseHandler,
        req: request(`${base}/parties/${created.id}`, {
          method: "PATCH",
          json: {
            expectedVersion: created.version,
            tradingName: "Updated",
            permissions: ["party:update"],
          },
        }),
        params: { tenantId, partyId: created.id },
      }),
    },
    {
      name: "POST /parties/{id}/archive",
      permission: PERMISSIONS.PARTY_ARCHIVE,
      neighbor: PERMISSIONS.PARTY_UPDATE,
      legalEntities: "A",
      success: 200,
      run: async ({ base, tenantId, created }) => ({
        handler: partyArchive as unknown as LooseHandler,
        req: request(`${base}/parties/${created.id}/archive`, {
          method: "POST",
          json: { expectedVersion: created.version },
        }),
        params: { tenantId, partyId: created.id },
      }),
    },
    {
      name: "POST /parties/{id}/ownership-transfer",
      permission: PERMISSIONS.PARTY_TRANSFER_OWNERSHIP,
      neighbor: PERMISSIONS.PARTY_UPDATE,
      legalEntities: "AB",
      success: 200,
      run: async ({ base, tenantId, created, leB }) => ({
        handler: partyTransfer as unknown as LooseHandler,
        req: request(`${base}/parties/${created.id}/ownership-transfer`, {
          method: "POST",
          json: { newOwnerLegalEntityId: leB, expectedVersion: created.version },
        }),
        params: { tenantId, partyId: created.id },
      }),
    },
    {
      name: "POST /parties/duplicate-candidates",
      permission: PERMISSIONS.PARTY_READ,
      neighbor: PERMISSIONS.PARTY_CREATE,
      legalEntities: "A",
      success: 200,
      run: async ({ base, tenantId }) => ({
        handler: duplicatePost as unknown as LooseHandler,
        req: request(`${base}/parties/duplicate-candidates`, {
          method: "POST",
          json: {
            legalName: "Perm Co",
            partyType: "ORGANISATION",
          },
        }),
        params: { tenantId },
      }),
    },
    {
      name: "GET /parties/{id}/contacts",
      permission: PERMISSIONS.PARTY_CONTACT_READ,
      neighbor: PERMISSIONS.PARTY_CONTACT_CREATE,
      legalEntities: "A",
      success: 200,
      run: async ({ base, tenantId, created }) => ({
        handler: contactsGet as unknown as LooseHandler,
        req: request(`${base}/parties/${created.id}/contacts`),
        params: { tenantId, partyId: created.id },
      }),
    },
    {
      name: "POST /parties/{id}/contacts",
      permission: PERMISSIONS.PARTY_CONTACT_CREATE,
      neighbor: PERMISSIONS.PARTY_CONTACT_READ,
      legalEntities: "A",
      success: 201,
      run: async ({ base, tenantId, created }) => ({
        handler: contactsPost as unknown as LooseHandler,
        req: request(`${base}/parties/${created.id}/contacts`, {
          method: "POST",
          json: { givenName: "New" },
        }),
        params: { tenantId, partyId: created.id },
      }),
    },
    {
      name: "GET /party-contacts/{id}",
      permission: PERMISSIONS.PARTY_CONTACT_READ,
      neighbor: PERMISSIONS.PARTY_CONTACT_UPDATE,
      legalEntities: "A",
      success: 200,
      run: async ({ base, tenantId, contact }) => ({
        handler: contactGet as unknown as LooseHandler,
        req: request(`${base}/party-contacts/${contact.id}`),
        params: { tenantId, contactId: contact.id },
      }),
    },
    {
      name: "PATCH /party-contacts/{id}",
      permission: PERMISSIONS.PARTY_CONTACT_UPDATE,
      neighbor: PERMISSIONS.PARTY_CONTACT_ARCHIVE,
      legalEntities: "A",
      success: 200,
      run: async ({ base, tenantId, contact }) => ({
        handler: contactPatch as unknown as LooseHandler,
        req: request(`${base}/party-contacts/${contact.id}`, {
          method: "PATCH",
          json: { expectedVersion: contact.version, jobTitle: "Buyer" },
        }),
        params: { tenantId, contactId: contact.id },
      }),
    },
    {
      name: "POST /party-contacts/{id}/archive",
      permission: PERMISSIONS.PARTY_CONTACT_ARCHIVE,
      neighbor: PERMISSIONS.PARTY_CONTACT_UPDATE,
      legalEntities: "A",
      success: 200,
      run: async ({ base, tenantId, contact }) => ({
        handler: contactArchive as unknown as LooseHandler,
        req: request(`${base}/party-contacts/${contact.id}/archive`, {
          method: "POST",
          json: { expectedVersion: contact.version },
        }),
        params: { tenantId, contactId: contact.id },
      }),
    },
    {
      name: "GET /parties/{id}/addresses",
      permission: PERMISSIONS.PARTY_ADDRESS_READ,
      neighbor: PERMISSIONS.PARTY_ADDRESS_CREATE,
      legalEntities: "A",
      success: 200,
      run: async ({ base, tenantId, created }) => ({
        handler: addressesGet as unknown as LooseHandler,
        req: request(`${base}/parties/${created.id}/addresses`),
        params: { tenantId, partyId: created.id },
      }),
    },
    {
      name: "POST /parties/{id}/addresses",
      permission: PERMISSIONS.PARTY_ADDRESS_CREATE,
      neighbor: PERMISSIONS.PARTY_ADDRESS_READ,
      legalEntities: "A",
      success: 201,
      run: async ({ base, tenantId, created }) => ({
        handler: addressesPost as unknown as LooseHandler,
        req: request(`${base}/parties/${created.id}/addresses`, {
          method: "POST",
          json: { addressType: "BILLING", line1: "2 Street", countryCode: "SG" },
        }),
        params: { tenantId, partyId: created.id },
      }),
    },
    {
      name: "GET /party-addresses/{id}",
      permission: PERMISSIONS.PARTY_ADDRESS_READ,
      neighbor: PERMISSIONS.PARTY_ADDRESS_UPDATE,
      legalEntities: "A",
      success: 200,
      run: async ({ base, tenantId, address }) => ({
        handler: addressGet as unknown as LooseHandler,
        req: request(`${base}/party-addresses/${address.id}`),
        params: { tenantId, addressId: address.id },
      }),
    },
    {
      name: "PATCH /party-addresses/{id}",
      permission: PERMISSIONS.PARTY_ADDRESS_UPDATE,
      neighbor: PERMISSIONS.PARTY_ADDRESS_ARCHIVE,
      legalEntities: "A",
      success: 200,
      run: async ({ base, tenantId, address }) => ({
        handler: addressPatch as unknown as LooseHandler,
        req: request(`${base}/party-addresses/${address.id}`, {
          method: "PATCH",
          json: { expectedVersion: address.version, city: "Singapore" },
        }),
        params: { tenantId, addressId: address.id },
      }),
    },
    {
      name: "POST /party-addresses/{id}/archive",
      permission: PERMISSIONS.PARTY_ADDRESS_ARCHIVE,
      neighbor: PERMISSIONS.PARTY_ADDRESS_UPDATE,
      legalEntities: "A",
      success: 200,
      run: async ({ base, tenantId, address }) => ({
        handler: addressArchive as unknown as LooseHandler,
        req: request(`${base}/party-addresses/${address.id}/archive`, {
          method: "POST",
          json: { expectedVersion: address.version },
        }),
        params: { tenantId, addressId: address.id },
      }),
    },
  ];

  it("grants only the exact tenant-wide key for each of the 17 operations", async () => {
    const seeded = await seed();
    const { leA, leB } = seeded.fixture;
    for (const op of matrix) {
      partyApiAuth.userId = seeded.fixture.setup.adminUserId;
      const createdRes = await invoke(
        listCreatePost,
        request(`${seeded.base}/parties`, {
          method: "POST",
          json: {
            ownerLegalEntityId: leA.id,
            code: partyCode(),
            partyType: "ORGANISATION",
            legalName: "Perm Co",
          },
        }),
        { tenantId: seeded.tenantId },
      );
      const created = (
        (await readJson(createdRes)).data as { party: { id: string; version: number } }
      ).party;
      await createAssignment(seeded.fixture.ctxAB, {
        partyId: created.id,
        legalEntityId: leB.id,
      });
      const contactRes = await invoke(
        contactsPost,
        request(`${seeded.base}/parties/${created.id}/contacts`, {
          method: "POST",
          json: { givenName: "Pat" },
        }),
        { tenantId: seeded.tenantId, partyId: created.id },
      );
      const contact = (
        (await readJson(contactRes)).data as { contact: { id: string; version: number } }
      ).contact;
      const addressRes = await invoke(
        addressesPost,
        request(`${seeded.base}/parties/${created.id}/addresses`, {
          method: "POST",
          json: { addressType: "GENERAL", line1: "1 Street", countryCode: "SG" },
        }),
        { tenantId: seeded.tenantId, partyId: created.id },
      );
      const address = (
        (await readJson(addressRes)).data as { address: { id: string; version: number } }
      ).address;
      const actor = await createActor(
        seeded.tenantId,
        seeded.fixture.setup.adminUserId,
        [op.permission],
        op.legalEntities === "AB" ? [leA.id, leB.id] : [leA.id],
      );
      extraUsers.push(actor.id);
      partyApiAuth.userId = actor.id;
      const call = await op.run({
        base: seeded.base,
        tenantId: seeded.tenantId,
        created,
        contact,
        address,
        leA: leA.id,
        leB: leB.id,
      });
      const res = await invokeLoose(call.handler, call.req, call.params);
      expect(res.status, op.name).toBe(op.success);
    }
  }, 120_000);

  it("rejects a missing key, a neighbouring key, and a permission string in the body", async () => {
    const seeded = await seed();
    const { leA, leB } = seeded.fixture;
    for (const op of matrix) {
      const none = await createActor(
        seeded.tenantId,
        seeded.fixture.setup.adminUserId,
        [],
        op.legalEntities === "AB" ? [leA.id, leB.id] : [leA.id],
      );
      extraUsers.push(none.id);
      const neighbor = await createActor(
        seeded.tenantId,
        seeded.fixture.setup.adminUserId,
        [op.neighbor],
        op.legalEntities === "AB" ? [leA.id, leB.id] : [leA.id],
      );
      extraUsers.push(neighbor.id);
      const call = await op.run({
        base: seeded.base,
        tenantId: seeded.tenantId,
        created: seeded.created,
        contact: seeded.contact,
        address: seeded.address,
        leA: leA.id,
        leB: leB.id,
      });
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
    }
  }, 120_000);

  it("does not treat entity-scoped-only permission as tenant-wide for owner-derived routes", async () => {
    const seeded = await seed();
    const { leA } = seeded.fixture;
    const scoped = await createActor(
      seeded.tenantId,
      seeded.fixture.setup.adminUserId,
      [PERMISSIONS.PARTY_UPDATE],
      [leA.id],
      leA.id,
    );
    extraUsers.push(scoped.id);
    partyApiAuth.userId = scoped.id;
    const res = await invoke(
      partyPatch,
      request(`${seeded.base}/parties/${seeded.created.id}`, {
        method: "PATCH",
        json: { expectedVersion: seeded.created.version, tradingName: "No" },
      }),
      { tenantId: seeded.tenantId, partyId: seeded.created.id },
    );
    expect(res.status).toBe(403);
  });

  it("authorizes POST /parties against the body owner legal entity and not another entity", async () => {
    const seeded = await seed();
    const { leA, leB } = seeded.fixture;
    const actor = await createActor(
      seeded.tenantId,
      seeded.fixture.setup.adminUserId,
      [PERMISSIONS.PARTY_CREATE],
      [leA.id, leB.id],
      leA.id,
    );
    extraUsers.push(actor.id);
    partyApiAuth.userId = actor.id;
    const ok = await invoke(
      listCreatePost,
      request(`${seeded.base}/parties`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: partyCode(),
          partyType: "ORGANISATION",
          legalName: "Scoped Owner Co",
        },
      }),
      { tenantId: seeded.tenantId },
    );
    expect(ok.status).toBe(201);
    const denied = await invoke(
      listCreatePost,
      request(`${seeded.base}/parties`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leB.id,
          code: partyCode(),
          partyType: "ORGANISATION",
          legalName: "Wrong Entity Co",
        },
      }),
      { tenantId: seeded.tenantId },
    );
    expect(denied.status).toBe(403);
    partyApiAuth.userId = actor.id;
    const extraPerms = await invoke(
      listCreatePost,
      request(`${seeded.base}/parties`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: partyCode(),
          partyType: "ORGANISATION",
          legalName: "Body Perms Co",
          permissions: [PERMISSIONS.PARTY_CREATE, PERMISSIONS.PARTY_ARCHIVE],
        },
      }),
      { tenantId: seeded.tenantId },
    );
    expect(extraPerms.status).toBe(201);
  });

  it("rejects forged Origin without consuming write buckets and accounts limiter use", async () => {
    const seeded = await seed();
    const tenantId = seeded.tenantId;
    const userId = seeded.fixture.setup.adminUserId;
    const { leA } = seeded.fixture;
    const before = await writeBucketCounts(tenantId, userId);
    const mutationSnapshot = () =>
      withTenantContext(
        { tenantId, legalEntityIds: new Set(seeded.fixture.ctxAB.legalEntityIds) },
        async (tx) => ({
          parties: await tx.party.count({ where: { tenantId } }),
          party: await tx.party.findFirstOrThrow({
            where: { id: seeded.created.id },
            select: {
              id: true,
              version: true,
              tradingName: true,
              status: true,
              updatedAt: true,
            },
          }),
          contact: await tx.partyContact.findFirstOrThrow({
            where: { id: seeded.contact.id },
            select: { id: true, version: true, status: true, archivedAt: true },
          }),
          address: await tx.partyAddress.findFirstOrThrow({
            where: { id: seeded.address.id },
            select: { id: true, version: true, status: true, archivedAt: true },
          }),
          audits: await tx.auditEvent.count({ where: { tenantId } }),
        }),
      );
    const beforeState = await mutationSnapshot();
    const evil = { Origin: "https://evil.example" };
    const csrfCases: Array<[string, Promise<Response>]> = [
      [
        "create",
        invoke(
          listCreatePost,
          request(`${seeded.base}/parties`, {
            method: "POST",
            headers: evil,
            json: {
              ownerLegalEntityId: leA.id,
              code: partyCode(),
              partyType: "ORGANISATION",
              legalName: "Csrf Co",
            },
          }),
          { tenantId },
        ),
      ],
      [
        "update",
        invoke(
          partyPatch,
          request(`${seeded.base}/parties/${seeded.created.id}`, {
            method: "PATCH",
            headers: evil,
            json: { expectedVersion: seeded.created.version, tradingName: "No" },
          }),
          { tenantId, partyId: seeded.created.id },
        ),
      ],
      [
        "contact-archive",
        invoke(
          contactArchive,
          request(`${seeded.base}/party-contacts/${seeded.contact.id}/archive`, {
            method: "POST",
            headers: evil,
            json: { expectedVersion: seeded.contact.version },
          }),
          { tenantId, contactId: seeded.contact.id },
        ),
      ],
      [
        "address-archive",
        invoke(
          addressArchive,
          request(`${seeded.base}/party-addresses/${seeded.address.id}/archive`, {
            method: "POST",
            headers: evil,
            json: { expectedVersion: seeded.address.version },
          }),
          { tenantId, addressId: seeded.address.id },
        ),
      ],
      [
        "duplicate",
        invoke(
          duplicatePost,
          request(`${seeded.base}/parties/duplicate-candidates`, {
            method: "POST",
            headers: evil,
            json: { legalName: "Perm Co" },
          }),
          { tenantId },
        ),
      ],
    ];
    for (const [label, pending] of csrfCases) {
      const res = await pending;
      expect(res.status, label).toBe(403);
    }
    expect(await writeBucketCounts(tenantId, userId)).toEqual(before);
    expect(await mutationSnapshot()).toEqual(beforeState);

    const reader = await createActor(
      tenantId,
      seeded.fixture.setup.adminUserId,
      [PERMISSIONS.PARTY_READ],
      [leA.id],
    );
    extraUsers.push(reader.id);
    partyApiAuth.userId = reader.id;
    const denied = await invoke(
      listCreatePost,
      request(`${seeded.base}/parties`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: partyCode(),
          partyType: "ORGANISATION",
          legalName: "Denied Co",
        },
      }),
      { tenantId },
    );
    expect(denied.status).toBe(403);
    expect(await writeBucketCounts(tenantId, reader.id)).toEqual({
      user: 0,
      tenant: before.tenant,
    });

    partyApiAuth.userId = userId;
    const listed = await invoke(listCreateGet, request(`${seeded.base}/parties`), {
      tenantId,
    });
    expect(listed.status).toBe(200);
    expect(await writeBucketCounts(tenantId, userId)).toEqual(before);

    const advisory = await invoke(
      duplicatePost,
      request(`${seeded.base}/parties/duplicate-candidates`, {
        method: "POST",
        json: { legalName: "Perm Co" },
      }),
      { tenantId },
    );
    expect(advisory.status).toBe(200);
    expect(await writeBucketCounts(tenantId, userId)).toEqual(before);

    const wrote = await invoke(
      listCreatePost,
      request(`${seeded.base}/parties`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: partyCode(),
          partyType: "ORGANISATION",
          legalName: "Counted Co",
        },
      }),
      { tenantId },
    );
    expect(wrote.status).toBe(201);
    expect(await writeBucketCounts(tenantId, userId)).toEqual({
      user: before.user + 1,
      tenant: before.tenant + 1,
    });
  });
});
