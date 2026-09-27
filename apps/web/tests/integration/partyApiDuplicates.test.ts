import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { PERMISSIONS } from "@noahark/authz";
import { withTenantContext } from "@noahark/db";
import { createSystemClient } from "@noahark/db/system";
import { createAssignment } from "@noahark/crm";
import {
  API_WRITE_TENANT,
  API_WRITE_TENANT_USER,
  apiWriteCanonicalKey,
  hashKey,
} from "@/lib/rateLimiter";
import { POST as listCreatePost } from "@/app/api/v1/tenants/[tenantId]/parties/route";
import { POST as partyArchive } from "@/app/api/v1/tenants/[tenantId]/parties/[partyId]/archive/route";
import { POST as duplicatePost } from "@/app/api/v1/tenants/[tenantId]/parties/duplicate-candidates/route";
import { POST as contactsPost } from "@/app/api/v1/tenants/[tenantId]/parties/[partyId]/contacts/route";
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

const CANDIDATE_KEYS = ["matchReasons", "partyId", "partyType"];
const FORBIDDEN_CANDIDATE_KEYS = [
  "legalName",
  "tradingName",
  "givenName",
  "familyName",
  "taxIdentifier",
  "code",
  "ownerLegalEntityId",
  "ownerId",
  "legalEntityId",
  "createdAt",
  "updatedAt",
  "archivedAt",
  "version",
  "assignment",
  "assignments",
  "customerRole",
  "vendorRole",
  "email",
  "phone",
  "status",
];

function assertSafeCandidates(
  label: string,
  candidates: unknown[],
  expectPartyId?: string,
) {
  expect(Array.isArray(candidates), `${label} array`).toBe(true);
  if (expectPartyId) {
    expect(
      candidates.some((row) => (row as { partyId: string }).partyId === expectPartyId),
      `${label} includes visible party`,
    ).toBe(true);
  }
  for (const raw of candidates) {
    expect(raw, label).not.toBeNull();
    expect(typeof raw, label).toBe("object");
    const rec = raw as Record<string, unknown>;
    expect(Object.keys(rec).sort(), `${label} keys`).toEqual(CANDIDATE_KEYS);
    for (const key of FORBIDDEN_CANDIDATE_KEYS) {
      expect(rec, `${label} leak ${key}`).not.toHaveProperty(key);
    }
    expect(typeof rec.partyId).toBe("string");
    expect(["ORGANISATION", "INDIVIDUAL"]).toContain(rec.partyType);
    expect(Array.isArray(rec.matchReasons)).toBe(true);
  }
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function assertSecretAbsent(label: string, text: string, secret: string) {
  expect(text.includes(secret), label).toBe(false);
}

describe("P2D.2a party API duplicate non-disclosure", () => {
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

  it("hides out-of-scope and archived candidates and never discloses contact data", async () => {
    fixture = await setupPartyDomainFixture();
    const { setup, leA, leB, leId, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    partyApiAuth.userId = setup.adminUserId;
    const secretEmail = `${uniqueSlug("probe")}@nondisclose.example`;
    const targetName = "Duplicate Target Co";
    const targetTax = "TAX-DUP-1";

    const first = await invoke(
      listCreatePost,
      request(`${base}/parties`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: partyCode(),
          partyType: "ORGANISATION",
          legalName: targetName,
          taxIdentifier: targetTax,
          customerRole: { code: partyCode("CUST") },
        },
      }),
      { tenantId },
    );
    expect(first.status).toBe(201);
    const firstBody = (await readJson(first)).data as {
      party: { id: string; version: number; code: string };
      duplicateCandidates: unknown[];
    };
    assertSafeCandidates("createParty-first", firstBody.duplicateCandidates);
    await createAssignment(ctxAB, { partyId: firstBody.party.id, legalEntityId: leB.id });

    const contactCreate = await invoke(
      contactsPost,
      request(`${base}/parties/${firstBody.party.id}/contacts`, {
        method: "POST",
        json: { givenName: "Pat", email: secretEmail, phone: "111" },
      }),
      { tenantId, partyId: firstBody.party.id },
    );
    expect(contactCreate.status).toBe(201);

    const assigned = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.PARTY_READ, PERMISSIONS.PARTY_CREATE],
      [leB.id],
    );
    extraUsers.push(assigned.id);
    const outOfScope = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.PARTY_READ, PERMISSIONS.PARTY_CREATE],
      [leId.id],
    );
    extraUsers.push(outOfScope.id);

    other = await setupTestTenant();
    const otherLe = await createTestLegalEntity(other.tenantId, "SG");
    await grantLegalEntityAccessDirect(other.tenantId, otherLe.id, other.adminUserId);

    async function advisoryAs(
      label: string,
      userId: string,
      pathTenantId: string,
      expectVisible: boolean,
    ) {
      partyApiAuth.userId = userId;
      const res = await invoke(
        duplicatePost,
        request(
          `https://noahark.example/api/v1/tenants/${pathTenantId}/parties/duplicate-candidates`,
          {
            method: "POST",
            json: {
              legalName: targetName,
              partyType: "ORGANISATION",
              taxIdentifier: targetTax,
              contactEmail: secretEmail,
            },
          },
        ),
        { tenantId: pathTenantId },
      );
      expect(res.status, `${label} status`).toBe(200);
      const text = await res.clone().text();
      assertSecretAbsent(`${label} secret`, text, secretEmail);
      const candidates = (JSON.parse(text) as { data: { candidates: unknown[] } }).data
        .candidates;
      if (expectVisible) {
        assertSafeCandidates(label, candidates, firstBody.party.id);
      } else {
        assertSafeCandidates(label, candidates);
        expect(
          candidates.some(
            (row) => (row as { partyId: string }).partyId === firstBody.party.id,
          ),
          `${label} hidden`,
        ).toBe(false);
      }
    }

    async function embeddedAs(
      label: string,
      userId: string,
      ownerLegalEntityId: string,
      expectVisible: boolean,
    ) {
      partyApiAuth.userId = userId;
      const res = await invoke(
        listCreatePost,
        request(`${base}/parties`, {
          method: "POST",
          json: {
            ownerLegalEntityId,
            code: partyCode(),
            partyType: "ORGANISATION",
            legalName: targetName,
            taxIdentifier: targetTax,
            contactEmailForDuplicateCheck: secretEmail,
          },
        }),
        { tenantId },
      );
      expect(res.status, `${label} status`).toBe(201);
      const parsed = (await readJson(res)) as {
        data: { duplicateCandidates: unknown[] };
      };
      const text = JSON.stringify(parsed.data.duplicateCandidates);
      assertSecretAbsent(`${label} secret`, text, secretEmail);
      if (expectVisible) {
        assertSafeCandidates(label, parsed.data.duplicateCandidates, firstBody.party.id);
      } else {
        assertSafeCandidates(label, parsed.data.duplicateCandidates);
        expect(
          parsed.data.duplicateCandidates.some(
            (row) => (row as { partyId: string }).partyId === firstBody.party.id,
          ),
          `${label} hidden`,
        ).toBe(false);
      }
    }

    await advisoryAs("advisory-assigned-reader", assigned.id, tenantId, true);
    await embeddedAs("createParty-assigned-reader", assigned.id, leB.id, true);
    await advisoryAs("advisory-out-of-scope", outOfScope.id, tenantId, false);
    await advisoryAs(
      "advisory-positive-control-after-out-of-scope",
      assigned.id,
      tenantId,
      true,
    );
    await embeddedAs("createParty-out-of-scope", outOfScope.id, leId.id, false);
    await advisoryAs("advisory-other-tenant", other.adminUserId, other.tenantId, false);
    partyApiAuth.userId = other.adminUserId;
    const otherCreate = await invoke(
      listCreatePost,
      request(`https://noahark.example/api/v1/tenants/${other.tenantId}/parties`, {
        method: "POST",
        json: {
          ownerLegalEntityId: otherLe.id,
          code: partyCode(),
          partyType: "ORGANISATION",
          legalName: targetName,
          taxIdentifier: targetTax,
          contactEmailForDuplicateCheck: secretEmail,
        },
      }),
      { tenantId: other.tenantId },
    );
    expect(otherCreate.status).toBe(201);
    const otherCandidates = (
      (await readJson(otherCreate)).data as { duplicateCandidates: unknown[] }
    ).duplicateCandidates;
    assertSafeCandidates("createParty-other-tenant", otherCandidates);
    expect(
      otherCandidates.some(
        (row) => (row as { partyId: string }).partyId === firstBody.party.id,
      ),
    ).toBe(false);
    await advisoryAs(
      "advisory-positive-control-after-cross-tenant",
      assigned.id,
      tenantId,
      true,
    );

    partyApiAuth.userId = setup.adminUserId;
    const emailOnly = await invoke(
      duplicatePost,
      request(`${base}/parties/duplicate-candidates`, {
        method: "POST",
        json: { contactEmail: secretEmail },
      }),
      { tenantId },
    );
    expect(emailOnly.status).toBe(200);
    const emailText = await emailOnly.clone().text();
    assertSecretAbsent("email-match-body", emailText, secretEmail);
    const emailCandidates = (JSON.parse(emailText) as { data: { candidates: unknown[] } })
      .data.candidates;
    assertSafeCandidates("email-match", emailCandidates, firstBody.party.id);
    expect(emailText.includes("Pat")).toBe(false);

    const extra = await invoke(
      duplicatePost,
      request(`${base}/parties/duplicate-candidates`, {
        method: "POST",
        json: { legalName: targetName, contactEmail: secretEmail, unexpected: true },
      }),
      { tenantId },
    );
    expect(extra.status).toBe(422);
    const extraText = await extra.clone().text();
    assertSecretAbsent("validation-secret", extraText, secretEmail);

    const beforeAudit = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) => tx.auditEvent.findMany({ where: { tenantId } }),
    );
    expect(jsonText(beforeAudit).includes(secretEmail)).toBe(false);

    const beforeBuckets = await writeBucketCounts(tenantId, setup.adminUserId);
    const csrf = await invoke(
      duplicatePost,
      request(`${base}/parties/duplicate-candidates`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        json: { legalName: targetName, contactEmail: secretEmail },
      }),
      { tenantId },
    );
    expect(csrf.status).toBe(403);
    assertSecretAbsent("csrf-secret", await csrf.clone().text(), secretEmail);
    const afterCsrfBuckets = await writeBucketCounts(tenantId, setup.adminUserId);
    expect(afterCsrfBuckets).toEqual(beforeBuckets);

    const readOnly = await invoke(
      duplicatePost,
      request(`${base}/parties/duplicate-candidates`, {
        method: "POST",
        json: { legalName: targetName, contactEmail: secretEmail },
      }),
      { tenantId },
    );
    expect(readOnly.status).toBe(200);
    expect(await writeBucketCounts(tenantId, setup.adminUserId)).toEqual(beforeBuckets);

    const archived = await invoke(
      partyArchive,
      request(`${base}/parties/${firstBody.party.id}/archive`, {
        method: "POST",
        json: { expectedVersion: firstBody.party.version },
      }),
      { tenantId, partyId: firstBody.party.id },
    );
    expect(archived.status).toBe(200);
    await advisoryAs("advisory-archived", assigned.id, tenantId, false);
    await embeddedAs("createParty-archived", assigned.id, leB.id, false);

    const afterAudit = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) => tx.auditEvent.findMany({ where: { tenantId } }),
    );
    expect(jsonText(afterAudit).includes(secretEmail)).toBe(false);
  }, 60_000);
});
