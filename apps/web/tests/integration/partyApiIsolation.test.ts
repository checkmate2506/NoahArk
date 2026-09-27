import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { PERMISSIONS } from "@noahark/authz";
import { createSystemClient } from "@noahark/db/system";
import {
  GET as listCreateGet,
  POST as listCreatePost,
} from "@/app/api/v1/tenants/[tenantId]/parties/route";
import {
  GET as partyGet,
  PATCH as partyPatch,
} from "@/app/api/v1/tenants/[tenantId]/parties/[partyId]/route";
import { POST as partyTransfer } from "@/app/api/v1/tenants/[tenantId]/parties/[partyId]/ownership-transfer/route";
import { POST as partyArchive } from "@/app/api/v1/tenants/[tenantId]/parties/[partyId]/archive/route";
import { POST as contactsPost } from "@/app/api/v1/tenants/[tenantId]/parties/[partyId]/contacts/route";
import {
  GET as contactGet,
  PATCH as contactPatch,
} from "@/app/api/v1/tenants/[tenantId]/party-contacts/[contactId]/route";
import { POST as contactArchive } from "@/app/api/v1/tenants/[tenantId]/party-contacts/[contactId]/archive/route";
import { POST as addressesPost } from "@/app/api/v1/tenants/[tenantId]/parties/[partyId]/addresses/route";
import {
  GET as addressGet,
  PATCH as addressPatch,
} from "@/app/api/v1/tenants/[tenantId]/party-addresses/[addressId]/route";
import { POST as addressArchive } from "@/app/api/v1/tenants/[tenantId]/party-addresses/[addressId]/archive/route";
import { createAssignment } from "@noahark/crm";
import { withTenantContext } from "@noahark/db";
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
  await assignRoleDirect(tenantId, mem.id, role.id, adminUserId, null);
  for (const legalEntityId of legalEntityIds) {
    await grantLegalEntityAccessDirect(tenantId, legalEntityId, user.id);
  }
  return user;
}

function errorCode(resBody: Record<string, unknown>): string {
  return (resBody.error as { code: string }).code;
}

describe("P2D.2a party API isolation", () => {
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

  it("proves owner, assigned reader, forbidden-not-found, cross-tenant, empty scope and transfer authority", async () => {
    fixture = await setupPartyDomainFixture();
    const { setup, leA, leB, leId, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    partyApiAuth.userId = setup.adminUserId;

    const createdRes = await invoke(
      listCreatePost,
      request(`${base}/parties`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: partyCode(),
          partyType: "ORGANISATION",
          legalName: "Iso Co",
        },
      }),
      { tenantId },
    );
    const party = (
      (await readJson(createdRes)).data as { party: { id: string; version: number } }
    ).party;
    await createAssignment(ctxAB, { partyId: party.id, legalEntityId: leB.id });
    const contactRes = await invoke(
      contactsPost,
      request(`${base}/parties/${party.id}/contacts`, {
        method: "POST",
        json: { givenName: "Pat" },
      }),
      { tenantId, partyId: party.id },
    );
    const contact = ((await readJson(contactRes)).data as { contact: { id: string } })
      .contact;
    const addressRes = await invoke(
      addressesPost,
      request(`${base}/parties/${party.id}/addresses`, {
        method: "POST",
        json: { addressType: "GENERAL", line1: "1 Street", countryCode: "SG" },
      }),
      { tenantId, partyId: party.id },
    );
    const address = ((await readJson(addressRes)).data as { address: { id: string } })
      .address;

    const ownerGet = await invoke(partyGet, request(`${base}/parties/${party.id}`), {
      tenantId,
      partyId: party.id,
    });
    expect(ownerGet.status).toBe(200);

    const assigned = await createActor(
      tenantId,
      setup.adminUserId,
      [
        PERMISSIONS.PARTY_READ,
        PERMISSIONS.PARTY_UPDATE,
        PERMISSIONS.PARTY_CONTACT_READ,
        PERMISSIONS.PARTY_CONTACT_UPDATE,
        PERMISSIONS.PARTY_ADDRESS_READ,
        PERMISSIONS.PARTY_ADDRESS_UPDATE,
      ],
      [leB.id],
    );
    extraUsers.push(assigned.id);
    partyApiAuth.userId = assigned.id;
    expect(
      (
        await invoke(partyGet, request(`${base}/parties/${party.id}`), {
          tenantId,
          partyId: party.id,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await invoke(contactGet, request(`${base}/party-contacts/${contact.id}`), {
          tenantId,
          contactId: contact.id,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await invoke(addressGet, request(`${base}/party-addresses/${address.id}`), {
          tenantId,
          addressId: address.id,
        })
      ).status,
    ).toBe(200);
    const assignedMutate = await invoke(
      partyPatch,
      request(`${base}/parties/${party.id}`, {
        method: "PATCH",
        json: { expectedVersion: party.version, tradingName: "Hijack" },
      }),
      { tenantId, partyId: party.id },
    );
    expect(assignedMutate.status).toBe(403);
    expect(errorCode(await readJson(assignedMutate))).toBe("FORBIDDEN");
    expect(
      (
        await invoke(
          contactPatch,
          request(`${base}/party-contacts/${contact.id}`, {
            method: "PATCH",
            json: { expectedVersion: 1, jobTitle: "No" },
          }),
          { tenantId, contactId: contact.id },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invoke(
          addressPatch,
          request(`${base}/party-addresses/${address.id}`, {
            method: "PATCH",
            json: { expectedVersion: 1, city: "No" },
          }),
          { tenantId, addressId: address.id },
        )
      ).status,
    ).toBe(403);

    const unrelated = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.PARTY_READ, PERMISSIONS.PARTY_UPDATE, PERMISSIONS.PARTY_CONTACT_READ],
      [leId.id],
    );
    extraUsers.push(unrelated.id);
    partyApiAuth.userId = unrelated.id;
    const hidden = await invoke(partyGet, request(`${base}/parties/${party.id}`), {
      tenantId,
      partyId: party.id,
    });
    expect(hidden.status).toBe(404);
    expect(errorCode(await readJson(hidden))).toBe("NOT_FOUND");

    other = await setupTestTenant();
    const otherLe = await createTestLegalEntity(other.tenantId, "SG");
    await grantLegalEntityAccessDirect(other.tenantId, otherLe.id, other.adminUserId);
    partyApiAuth.userId = other.adminUserId;
    const cross = await invoke(
      partyGet,
      request(
        `https://noahark.example/api/v1/tenants/${other.tenantId}/parties/${party.id}`,
      ),
      { tenantId: other.tenantId, partyId: party.id },
    );
    expect(cross.status).toBe(404);
    expect(errorCode(await readJson(cross))).toBe("NOT_FOUND");
    const missing = await invoke(
      partyGet,
      request(
        `https://noahark.example/api/v1/tenants/${other.tenantId}/parties/does-not-exist`,
      ),
      { tenantId: other.tenantId, partyId: "does-not-exist" },
    );
    expect(missing.status).toBe(404);
    expect(errorCode(await readJson(missing))).toBe("NOT_FOUND");

    partyApiAuth.userId = setup.adminUserId;
    const forgedTenant = await invoke(
      listCreateGet,
      request(`https://noahark.example/api/v1/tenants/${other.tenantId}/parties`),
      { tenantId: other.tenantId },
    );
    expect(forgedTenant.status).toBe(403);

    const emptyScope = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.PARTY_READ],
      [],
    );
    extraUsers.push(emptyScope.id);
    partyApiAuth.userId = emptyScope.id;
    const empty = await invoke(listCreateGet, request(`${base}/parties`), { tenantId });
    expect(empty.status).toBe(403);

    partyApiAuth.userId = setup.adminUserId;
    const widen = await invoke(
      partyPatch,
      request(`${base}/parties/${party.id}`, {
        method: "PATCH",
        json: {
          expectedVersion: party.version,
          ownerLegalEntityId: leB.id,
          tradingName: "Still A",
        },
      }),
      { tenantId, partyId: party.id },
    );
    expect(widen.status).toBe(200);
    expect(
      (
        (await readJson(widen)).data as {
          party: { ownerLegalEntityId: string; version: number };
        }
      ).party.ownerLegalEntityId,
    ).toBe(leA.id);

    const oldOnly = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.PARTY_TRANSFER_OWNERSHIP],
      [leA.id],
    );
    extraUsers.push(oldOnly.id);
    const newOnly = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.PARTY_TRANSFER_OWNERSHIP],
      [leB.id],
    );
    extraUsers.push(newOnly.id);
    const both = await createActor(
      tenantId,
      setup.adminUserId,
      [
        PERMISSIONS.PARTY_TRANSFER_OWNERSHIP,
        PERMISSIONS.PARTY_UPDATE,
        PERMISSIONS.PARTY_READ,
      ],
      [leA.id, leB.id],
    );
    extraUsers.push(both.id);

    const afterWiden = (
      (
        await readJson(
          await invoke(partyGet, request(`${base}/parties/${party.id}`), {
            tenantId,
            partyId: party.id,
          }),
        )
      ).data as { party: { version: number } }
    ).party;

    partyApiAuth.userId = oldOnly.id;
    expect(
      (
        await invoke(
          partyTransfer,
          request(`${base}/parties/${party.id}/ownership-transfer`, {
            method: "POST",
            json: { newOwnerLegalEntityId: leB.id, expectedVersion: afterWiden.version },
          }),
          { tenantId, partyId: party.id },
        )
      ).status,
    ).toBe(403);
    partyApiAuth.userId = newOnly.id;
    expect(
      (
        await invoke(
          partyTransfer,
          request(`${base}/parties/${party.id}/ownership-transfer`, {
            method: "POST",
            json: { newOwnerLegalEntityId: leB.id, expectedVersion: afterWiden.version },
          }),
          { tenantId, partyId: party.id },
        )
      ).status,
    ).toBe(403);
    partyApiAuth.userId = both.id;
    const transferred = await invoke(
      partyTransfer,
      request(`${base}/parties/${party.id}/ownership-transfer`, {
        method: "POST",
        json: { newOwnerLegalEntityId: leB.id, expectedVersion: afterWiden.version },
      }),
      { tenantId, partyId: party.id },
    );
    expect(transferred.status).toBe(200);
    const after = (
      (await readJson(transferred)).data as {
        party: { version: number; ownerLegalEntityId: string };
      }
    ).party;
    expect(after.ownerLegalEntityId).toBe(leB.id);

    const oldOwnerMutate = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.PARTY_UPDATE],
      [leA.id],
    );
    extraUsers.push(oldOwnerMutate.id);
    partyApiAuth.userId = oldOwnerMutate.id;
    expect(
      (
        await invoke(
          partyPatch,
          request(`${base}/parties/${party.id}`, {
            method: "PATCH",
            json: { expectedVersion: after.version, tradingName: "Old" },
          }),
          { tenantId, partyId: party.id },
        )
      ).status,
    ).toBe(403);
    const newOwnerMutate = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.PARTY_UPDATE],
      [leB.id],
    );
    extraUsers.push(newOwnerMutate.id);
    partyApiAuth.userId = newOwnerMutate.id;
    expect(
      (
        await invoke(
          partyPatch,
          request(`${base}/parties/${party.id}`, {
            method: "PATCH",
            json: { expectedVersion: after.version, tradingName: "New" },
          }),
          { tenantId, partyId: party.id },
        )
      ).status,
    ).toBe(200);
  }, 60_000);

  it("rejects assigned-non-owner archives and proves opaque not-found mutations", async () => {
    fixture = await setupPartyDomainFixture();
    const { setup, leA, leB, leId, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    partyApiAuth.userId = setup.adminUserId;
    const createdRes = await invoke(
      listCreatePost,
      request(`${base}/parties`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: partyCode(),
          partyType: "ORGANISATION",
          legalName: "Iso Archive Co",
        },
      }),
      { tenantId },
    );
    const party = (
      (await readJson(createdRes)).data as {
        party: { id: string; version: number; ownerLegalEntityId: string };
      }
    ).party;
    await createAssignment(ctxAB, { partyId: party.id, legalEntityId: leB.id });
    const contact = (
      (
        await readJson(
          await invoke(
            contactsPost,
            request(`${base}/parties/${party.id}/contacts`, {
              method: "POST",
              json: { givenName: "Pat" },
            }),
            { tenantId, partyId: party.id },
          ),
        )
      ).data as { contact: { id: string; version: number } }
    ).contact;
    const address = (
      (
        await readJson(
          await invoke(
            addressesPost,
            request(`${base}/parties/${party.id}/addresses`, {
              method: "POST",
              json: { addressType: "GENERAL", line1: "1 Street", countryCode: "SG" },
            }),
            { tenantId, partyId: party.id },
          ),
        )
      ).data as { address: { id: string; version: number } }
    ).address;

    async function snapshot() {
      return withTenantContext(
        { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
        async (tx) => ({
          partyRow: await tx.party.findFirstOrThrow({ where: { id: party.id } }),
          contactRow: await tx.partyContact.findFirstOrThrow({
            where: { id: contact.id },
          }),
          addressRow: await tx.partyAddress.findFirstOrThrow({
            where: { id: address.id },
          }),
          audits: await tx.auditEvent.count({ where: { tenantId } }),
        }),
      );
    }

    const assigned = await createActor(
      tenantId,
      setup.adminUserId,
      [
        PERMISSIONS.PARTY_READ,
        PERMISSIONS.PARTY_ARCHIVE,
        PERMISSIONS.PARTY_CONTACT_READ,
        PERMISSIONS.PARTY_CONTACT_ARCHIVE,
        PERMISSIONS.PARTY_ADDRESS_READ,
        PERMISSIONS.PARTY_ADDRESS_ARCHIVE,
      ],
      [leB.id],
    );
    extraUsers.push(assigned.id);
    const beforeAssigned = await snapshot();
    partyApiAuth.userId = assigned.id;
    for (const [label, res] of [
      [
        "assigned-non-owner-party-archive",
        await invoke(
          partyArchive,
          request(`${base}/parties/${party.id}/archive`, {
            method: "POST",
            json: { expectedVersion: party.version },
          }),
          { tenantId, partyId: party.id },
        ),
      ],
      [
        "assigned-non-owner-contact-archive",
        await invoke(
          contactArchive,
          request(`${base}/party-contacts/${contact.id}/archive`, {
            method: "POST",
            json: { expectedVersion: contact.version },
          }),
          { tenantId, contactId: contact.id },
        ),
      ],
      [
        "assigned-non-owner-address-archive",
        await invoke(
          addressArchive,
          request(`${base}/party-addresses/${address.id}/archive`, {
            method: "POST",
            json: { expectedVersion: address.version },
          }),
          { tenantId, addressId: address.id },
        ),
      ],
    ] as Array<[string, Response]>) {
      expect(res.status, label).toBe(403);
      expect(errorCode(await readJson(res)), label).toBe("FORBIDDEN");
    }
    expect(await snapshot()).toEqual(beforeAssigned);

    const unrelated = await createActor(
      tenantId,
      setup.adminUserId,
      [
        PERMISSIONS.PARTY_READ,
        PERMISSIONS.PARTY_UPDATE,
        PERMISSIONS.PARTY_ARCHIVE,
        PERMISSIONS.PARTY_TRANSFER_OWNERSHIP,
        PERMISSIONS.PARTY_CONTACT_READ,
        PERMISSIONS.PARTY_CONTACT_UPDATE,
        PERMISSIONS.PARTY_CONTACT_ARCHIVE,
        PERMISSIONS.PARTY_ADDRESS_READ,
        PERMISSIONS.PARTY_ADDRESS_UPDATE,
        PERMISSIONS.PARTY_ADDRESS_ARCHIVE,
      ],
      [leId.id],
    );
    extraUsers.push(unrelated.id);
    other = await setupTestTenant();
    const otherLe = await createTestLegalEntity(other.tenantId, "SG");
    await grantLegalEntityAccessDirect(other.tenantId, otherLe.id, other.adminUserId);

    const secrets = [
      tenantId,
      other.tenantId,
      leA.id,
      leB.id,
      leId.id,
      party.ownerLegalEntityId,
    ];

    function opaqueShape(body: Record<string, unknown>) {
      const error = body.error as {
        code: string;
        message: string;
        details: unknown;
      };
      return {
        code: error.code,
        message: error.message,
        detailsType: error.details == null ? "empty" : typeof error.details,
        detailsKeys:
          error.details && typeof error.details === "object"
            ? Object.keys(error.details as object).sort()
            : [],
      };
    }

    function assertOpaque(label: string, status: number, body: Record<string, unknown>) {
      expect(status, label).toBe(404);
      const text = JSON.stringify(body);
      for (const secret of secrets) {
        expect(text.includes(secret), `${label} leak`).toBe(false);
      }
      expect(text, label).not.toMatch(/"version"\s*:/);
      expect(text.toLowerCase(), label).not.toContain("ownerlegale");
    }

    type Mutation = {
      id: string;
      run: (
        pathTenantId: string,
        ids: { partyId: string; contactId: string; addressId: string },
      ) => Promise<Response>;
    };
    const mutations: Mutation[] = [
      {
        id: "party-patch",
        run: (tid, ids) =>
          invoke(
            partyPatch,
            request(
              `https://noahark.example/api/v1/tenants/${tid}/parties/${ids.partyId}`,
              {
                method: "PATCH",
                json: { expectedVersion: party.version, tradingName: "No" },
              },
            ),
            { tenantId: tid, partyId: ids.partyId },
          ),
      },
      {
        id: "party-archive",
        run: (tid, ids) =>
          invoke(
            partyArchive,
            request(
              `https://noahark.example/api/v1/tenants/${tid}/parties/${ids.partyId}/archive`,
              { method: "POST", json: { expectedVersion: party.version } },
            ),
            { tenantId: tid, partyId: ids.partyId },
          ),
      },
      {
        id: "party-transfer",
        run: (tid, ids) =>
          invoke(
            partyTransfer,
            request(
              `https://noahark.example/api/v1/tenants/${tid}/parties/${ids.partyId}/ownership-transfer`,
              {
                method: "POST",
                json: { newOwnerLegalEntityId: leB.id, expectedVersion: party.version },
              },
            ),
            { tenantId: tid, partyId: ids.partyId },
          ),
      },
      {
        id: "contact-patch",
        run: (tid, ids) =>
          invoke(
            contactPatch,
            request(
              `https://noahark.example/api/v1/tenants/${tid}/party-contacts/${ids.contactId}`,
              {
                method: "PATCH",
                json: { expectedVersion: contact.version, jobTitle: "No" },
              },
            ),
            { tenantId: tid, contactId: ids.contactId },
          ),
      },
      {
        id: "contact-archive",
        run: (tid, ids) =>
          invoke(
            contactArchive,
            request(
              `https://noahark.example/api/v1/tenants/${tid}/party-contacts/${ids.contactId}/archive`,
              { method: "POST", json: { expectedVersion: contact.version } },
            ),
            { tenantId: tid, contactId: ids.contactId },
          ),
      },
      {
        id: "address-patch",
        run: (tid, ids) =>
          invoke(
            addressPatch,
            request(
              `https://noahark.example/api/v1/tenants/${tid}/party-addresses/${ids.addressId}`,
              { method: "PATCH", json: { expectedVersion: address.version, city: "No" } },
            ),
            { tenantId: tid, addressId: ids.addressId },
          ),
      },
      {
        id: "address-archive",
        run: (tid, ids) =>
          invoke(
            addressArchive,
            request(
              `https://noahark.example/api/v1/tenants/${tid}/party-addresses/${ids.addressId}/archive`,
              { method: "POST", json: { expectedVersion: address.version } },
            ),
            { tenantId: tid, addressId: ids.addressId },
          ),
      },
    ];
    const idBasedReads: Mutation[] = [
      {
        id: "contact-get",
        run: (tid, ids) =>
          invoke(
            contactGet,
            request(
              `https://noahark.example/api/v1/tenants/${tid}/party-contacts/${ids.contactId}`,
            ),
            { tenantId: tid, contactId: ids.contactId },
          ),
      },
      {
        id: "address-get",
        run: (tid, ids) =>
          invoke(
            addressGet,
            request(
              `https://noahark.example/api/v1/tenants/${tid}/party-addresses/${ids.addressId}`,
            ),
            { tenantId: tid, addressId: ids.addressId },
          ),
      },
    ];
    expect(mutations).toHaveLength(7);
    expect(idBasedReads).toHaveLength(2);

    const missingIds = {
      partyId: "does-not-exist",
      contactId: "does-not-exist",
      addressId: "does-not-exist",
    };
    const realIds = { partyId: party.id, contactId: contact.id, addressId: address.id };

    for (const mutation of [...mutations, ...idBasedReads]) {
      const before = await snapshot();
      partyApiAuth.userId = unrelated.id;
      const unrelatedRes = await mutation.run(tenantId, realIds);
      const unrelatedBody = await readJson(unrelatedRes);
      assertOpaque(`unrelated/${mutation.id}`, unrelatedRes.status, unrelatedBody);

      partyApiAuth.userId = other.adminUserId;
      const crossRes = await mutation.run(other.tenantId, realIds);
      const crossBody = await readJson(crossRes);
      assertOpaque(`cross-tenant/${mutation.id}`, crossRes.status, crossBody);

      const missingRes = await mutation.run(other.tenantId, missingIds);
      const missingBody = await readJson(missingRes);
      assertOpaque(`missing/${mutation.id}`, missingRes.status, missingBody);

      expect(opaqueShape(unrelatedBody), `shape unrelated/${mutation.id}`).toEqual(
        opaqueShape(missingBody),
      );
      expect(opaqueShape(crossBody), `shape cross/${mutation.id}`).toEqual(
        opaqueShape(missingBody),
      );
      expect(unrelatedRes.status).toBe(missingRes.status);
      expect(await snapshot()).toEqual(before);
    }
  }, 60_000);

  it("proves owner-only Contact and Address creation isolation", async () => {
    fixture = await setupPartyDomainFixture();
    const { setup, leA, leB, leId, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    partyApiAuth.userId = setup.adminUserId;
    const createdRes = await invoke(
      listCreatePost,
      request(`${base}/parties`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: partyCode(),
          partyType: "ORGANISATION",
          legalName: "Iso Create Co",
        },
      }),
      { tenantId },
    );
    expect(createdRes.status).toBe(201);
    const party = ((await readJson(createdRes)).data as { party: { id: string } }).party;
    await createAssignment(ctxAB, { partyId: party.id, legalEntityId: leB.id });

    const childSnapshot = () =>
      withTenantContext(
        { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
        async (tx) => ({
          contacts: await tx.partyContact.count({ where: { partyId: party.id } }),
          addresses: await tx.partyAddress.count({ where: { partyId: party.id } }),
          audits: await tx.auditEvent.count({ where: { tenantId } }),
        }),
      );

    const ownerContact = await invoke(
      contactsPost,
      request(`${base}/parties/${party.id}/contacts`, {
        method: "POST",
        json: { givenName: "Owner" },
      }),
      { tenantId, partyId: party.id },
    );
    expect(ownerContact.status).toBe(201);
    const ownerAddress = await invoke(
      addressesPost,
      request(`${base}/parties/${party.id}/addresses`, {
        method: "POST",
        json: { addressType: "GENERAL", line1: "Owner Street", countryCode: "SG" },
      }),
      { tenantId, partyId: party.id },
    );
    expect(ownerAddress.status).toBe(201);
    const afterOwner = await childSnapshot();
    expect(afterOwner.contacts).toBe(1);
    expect(afterOwner.addresses).toBe(1);

    const assigned = await createActor(
      tenantId,
      setup.adminUserId,
      [
        PERMISSIONS.PARTY_READ,
        PERMISSIONS.PARTY_CONTACT_READ,
        PERMISSIONS.PARTY_CONTACT_CREATE,
        PERMISSIONS.PARTY_ADDRESS_READ,
        PERMISSIONS.PARTY_ADDRESS_CREATE,
      ],
      [leB.id],
    );
    extraUsers.push(assigned.id);
    partyApiAuth.userId = assigned.id;
    const assignedContact = await invoke(
      contactsPost,
      request(`${base}/parties/${party.id}/contacts`, {
        method: "POST",
        json: { givenName: "Assigned" },
      }),
      { tenantId, partyId: party.id },
    );
    expect(assignedContact.status).toBe(403);
    expect(errorCode(await readJson(assignedContact))).toBe("FORBIDDEN");
    const assignedAddress = await invoke(
      addressesPost,
      request(`${base}/parties/${party.id}/addresses`, {
        method: "POST",
        json: { addressType: "GENERAL", line1: "Assigned Street", countryCode: "SG" },
      }),
      { tenantId, partyId: party.id },
    );
    expect(assignedAddress.status).toBe(403);
    expect(errorCode(await readJson(assignedAddress))).toBe("FORBIDDEN");
    expect(await childSnapshot()).toEqual(afterOwner);

    const unrelated = await createActor(
      tenantId,
      setup.adminUserId,
      [
        PERMISSIONS.PARTY_READ,
        PERMISSIONS.PARTY_CONTACT_READ,
        PERMISSIONS.PARTY_CONTACT_CREATE,
        PERMISSIONS.PARTY_ADDRESS_READ,
        PERMISSIONS.PARTY_ADDRESS_CREATE,
      ],
      [leId.id],
    );
    extraUsers.push(unrelated.id);
    partyApiAuth.userId = unrelated.id;
    const unrelatedContact = await invoke(
      contactsPost,
      request(`${base}/parties/${party.id}/contacts`, {
        method: "POST",
        json: { givenName: "Unrelated" },
      }),
      { tenantId, partyId: party.id },
    );
    expect(unrelatedContact.status).toBe(404);
    expect(errorCode(await readJson(unrelatedContact))).toBe("NOT_FOUND");
    const unrelatedAddress = await invoke(
      addressesPost,
      request(`${base}/parties/${party.id}/addresses`, {
        method: "POST",
        json: { addressType: "GENERAL", line1: "Unrelated Street", countryCode: "SG" },
      }),
      { tenantId, partyId: party.id },
    );
    expect(unrelatedAddress.status).toBe(404);
    expect(errorCode(await readJson(unrelatedAddress))).toBe("NOT_FOUND");
    expect(await childSnapshot()).toEqual(afterOwner);

    other = await setupTestTenant();
    const otherLe = await createTestLegalEntity(other.tenantId, "SG");
    await grantLegalEntityAccessDirect(other.tenantId, otherLe.id, other.adminUserId);
    partyApiAuth.userId = other.adminUserId;
    const crossContact = await invoke(
      contactsPost,
      request(
        `https://noahark.example/api/v1/tenants/${other.tenantId}/parties/${party.id}/contacts`,
        { method: "POST", json: { givenName: "Cross" } },
      ),
      { tenantId: other.tenantId, partyId: party.id },
    );
    expect(crossContact.status).toBe(404);
    expect(errorCode(await readJson(crossContact))).toBe("NOT_FOUND");
    const crossAddress = await invoke(
      addressesPost,
      request(
        `https://noahark.example/api/v1/tenants/${other.tenantId}/parties/${party.id}/addresses`,
        {
          method: "POST",
          json: { addressType: "GENERAL", line1: "Cross Street", countryCode: "SG" },
        },
      ),
      { tenantId: other.tenantId, partyId: party.id },
    );
    expect(crossAddress.status).toBe(404);
    expect(errorCode(await readJson(crossAddress))).toBe("NOT_FOUND");
    expect(await childSnapshot()).toEqual(afterOwner);
  }, 60_000);
});
