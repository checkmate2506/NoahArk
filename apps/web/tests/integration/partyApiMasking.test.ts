import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { PERMISSIONS } from "@noahark/authz";
import { withTenantContext } from "@noahark/db";
import { createSystemClient } from "@noahark/db/system";
import { POST as listCreatePost } from "@/app/api/v1/tenants/[tenantId]/parties/route";
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
  legalEntityId: string,
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
  await grantLegalEntityAccessDirect(tenantId, legalEntityId, user.id);
  return user;
}

const CONTACT_BASE_PERMS = [
  PERMISSIONS.PARTY_CONTACT_READ,
  PERMISSIONS.PARTY_CONTACT_CREATE,
  PERMISSIONS.PARTY_CONTACT_UPDATE,
  PERMISSIONS.PARTY_CONTACT_ARCHIVE,
];

type FieldCombo = {
  id: string;
  extraKeys: string[];
  expectEmail: boolean;
  expectPhone: boolean;
};

const FIELD_COMBOS: FieldCombo[] = [
  {
    id: "neither-field-permission",
    extraKeys: [],
    expectEmail: false,
    expectPhone: false,
  },
  {
    id: "email-permission-only",
    extraKeys: [PERMISSIONS.PARTY_CONTACT_EMAIL_READ],
    expectEmail: true,
    expectPhone: false,
  },
  {
    id: "phone-permission-only",
    extraKeys: [PERMISSIONS.PARTY_CONTACT_PHONE_READ],
    expectEmail: false,
    expectPhone: true,
  },
  {
    id: "both-field-permissions",
    extraKeys: [
      PERMISSIONS.PARTY_CONTACT_EMAIL_READ,
      PERMISSIONS.PARTY_CONTACT_PHONE_READ,
    ],
    expectEmail: true,
    expectPhone: true,
  },
  {
    id: "unrelated-permission",
    extraKeys: [PERMISSIONS.DEMO_PROTECTED_FIELD_READ],
    expectEmail: false,
    expectPhone: false,
  },
];

function asContact(value: unknown): {
  id: string;
  version: number;
  email: string | null;
  phone: string | null;
} {
  return value as {
    id: string;
    version: number;
    email: string | null;
    phone: string | null;
  };
}

function assertContactMasking(
  label: string,
  contact: { email: string | null; phone: string | null },
  combo: FieldCombo,
  storedEmail: string,
  storedPhone: string,
  serialized: string,
) {
  expect(
    Object.prototype.hasOwnProperty.call(contact, "email"),
    `${label} email present`,
  ).toBe(true);
  expect(
    Object.prototype.hasOwnProperty.call(contact, "phone"),
    `${label} phone present`,
  ).toBe(true);
  if (combo.expectEmail) {
    expect(contact.email, `${label} email visible`).toBe(storedEmail);
  } else {
    expect(contact.email, `${label} email masked`).toBeNull();
    expect(serialized.includes(storedEmail), `${label} email absent from body`).toBe(
      false,
    );
  }
  if (combo.expectPhone) {
    expect(contact.phone, `${label} phone visible`).toBe(storedPhone);
  } else {
    expect(contact.phone, `${label} phone masked`).toBeNull();
    expect(serialized.includes(storedPhone), `${label} phone absent from body`).toBe(
      false,
    );
  }
}

describe("P2D.2a party API contact masking", () => {
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

  it("proves the four field-permission combinations plus unrelated permission on all five contact-returning operations", async () => {
    fixture = await setupPartyDomainFixture();
    const { setup, leA } = fixture;
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
          legalName: "Mask Co",
        },
      }),
      { tenantId },
    );
    const partyId = ((await readJson(createdRes)).data as { party: { id: string } }).party
      .id;

    const actors: Array<{ combo: FieldCombo; userId: string }> = [];
    for (const combo of FIELD_COMBOS) {
      const user = await createActor(
        tenantId,
        setup.adminUserId,
        [...CONTACT_BASE_PERMS, ...combo.extraKeys],
        leA.id,
      );
      extraUsers.push(user.id);
      actors.push({ combo, userId: user.id });
    }

    for (const [index, { combo, userId }] of actors.entries()) {
      const storedEmail = `${combo.id}.${uniqueSlug("m")}@mask.example`;
      const storedPhone = `+6591${String(index + 1).padStart(6, "0")}`;
      partyApiAuth.userId = userId;

      const createdResOp = await invoke(
        contactsPost,
        request(`${base}/parties/${partyId}/contacts`, {
          method: "POST",
          json: { givenName: "Pat", email: storedEmail, phone: storedPhone },
        }),
        { tenantId, partyId },
      );
      expect(createdResOp.status, `create/${combo.id} status`).toBe(201);
      const createdText = await createdResOp.clone().text();
      const createdBody = JSON.parse(createdText) as Record<string, unknown>;
      const createdContact = asContact(
        (createdBody.data as { contact: unknown }).contact,
      );
      assertContactMasking(
        `create/${combo.id}`,
        createdContact,
        combo,
        storedEmail,
        storedPhone,
        createdText,
      );

      const gotRes = await invoke(
        contactGet,
        request(`${base}/party-contacts/${createdContact.id}`),
        { tenantId, contactId: createdContact.id },
      );
      expect(gotRes.status, `get/${combo.id} status`).toBe(200);
      const gotText = await gotRes.clone().text();
      const gotBody = JSON.parse(gotText) as Record<string, unknown>;
      const gotContact = asContact((gotBody.data as { contact: unknown }).contact);
      assertContactMasking(
        `get/${combo.id}`,
        gotContact,
        combo,
        storedEmail,
        storedPhone,
        gotText,
      );

      const listedRes = await invoke(
        contactsGet,
        request(`${base}/parties/${partyId}/contacts`),
        { tenantId, partyId },
      );
      expect(listedRes.status, `list/${combo.id} status`).toBe(200);
      const listedText = await listedRes.clone().text();
      const listedBody = JSON.parse(listedText) as Record<string, unknown>;
      const listedContacts = (
        listedBody.data as { contacts: Array<ReturnType<typeof asContact>> }
      ).contacts;
      const listedMatch = listedContacts.find((row) => row.id === createdContact.id);
      expect(listedMatch, `list/${combo.id} row`).toBeDefined();
      assertContactMasking(
        `list/${combo.id}`,
        listedMatch!,
        combo,
        storedEmail,
        storedPhone,
        listedText,
      );
      expect(listedMatch!.email, `list-detail agree email/${combo.id}`).toBe(
        gotContact.email,
      );
      expect(listedMatch!.phone, `list-detail agree phone/${combo.id}`).toBe(
        gotContact.phone,
      );

      const updatedRes = await invoke(
        contactPatch,
        request(`${base}/party-contacts/${createdContact.id}`, {
          method: "PATCH",
          json: { expectedVersion: createdContact.version, jobTitle: "Buyer" },
        }),
        { tenantId, contactId: createdContact.id },
      );
      expect(updatedRes.status, `update/${combo.id} status`).toBe(200);
      const updatedText = await updatedRes.clone().text();
      const updatedBody = JSON.parse(updatedText) as Record<string, unknown>;
      const updatedContact = asContact(
        (updatedBody.data as { contact: unknown }).contact,
      );
      assertContactMasking(
        `update/${combo.id}`,
        updatedContact,
        combo,
        storedEmail,
        storedPhone,
        updatedText,
      );

      const archivedRes = await invoke(
        contactArchive,
        request(`${base}/party-contacts/${createdContact.id}/archive`, {
          method: "POST",
          json: { expectedVersion: updatedContact.version },
        }),
        { tenantId, contactId: createdContact.id },
      );
      expect(archivedRes.status, `archive/${combo.id} status`).toBe(200);
      const archivedText = await archivedRes.clone().text();
      const archivedBody = JSON.parse(archivedText) as Record<string, unknown>;
      const archivedContact = asContact(
        (archivedBody.data as { contact: unknown }).contact,
      );
      assertContactMasking(
        `archive/${combo.id}`,
        archivedContact,
        combo,
        storedEmail,
        storedPhone,
        archivedText,
      );

      const audits = await withTenantContext(
        { tenantId, legalEntityIds: new Set([leA.id]) },
        (tx) => tx.auditEvent.findMany({ where: { tenantId } }),
      );
      const auditText = JSON.stringify(audits, (_key, item) =>
        typeof item === "bigint" ? item.toString() : item,
      );
      expect(auditText.includes(storedEmail), `audit email/${combo.id}`).toBe(false);
      expect(auditText.includes(storedPhone), `audit phone/${combo.id}`).toBe(false);
    }
  }, 60_000);
});
