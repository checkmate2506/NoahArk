import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { AUDIT_ACTIONS, verifyAuditChain, type AuditChainLink } from "@noahark/audit";
import { withTenantContext } from "@noahark/db";
import { createAssignment } from "@noahark/crm";
import { load as loadYaml } from "js-yaml";
import {
  API_WRITE_MAX_PER_TENANT_USER,
  consumeApiWriteAllowance,
} from "@/lib/rateLimiter";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { cleanupTenant, cleanupUser, uniqueSlug } from "./testHelpers";
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

export async function readJson(res: Response): Promise<Record<string, unknown>> {
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

const PARTY_KEYS = [
  "id",
  "ownerLegalEntityId",
  "code",
  "partyType",
  "legalName",
  "tradingName",
  "givenName",
  "familyName",
  "taxIdentifier",
  "status",
  "archivedAt",
  "version",
  "createdAt",
  "updatedAt",
];
const ASSIGNMENT_KEYS = [
  "id",
  "partyId",
  "legalEntityId",
  "status",
  "assignedAt",
  "archivedAt",
  "version",
  "createdAt",
  "updatedAt",
];
const ROLE_KEYS = [
  "id",
  "assignmentId",
  "legalEntityId",
  "code",
  "defaultCurrency",
  "status",
  "archivedAt",
  "version",
  "createdAt",
  "updatedAt",
];
const CONTACT_KEYS = [
  "id",
  "partyId",
  "givenName",
  "familyName",
  "jobTitle",
  "email",
  "phone",
  "isPrimary",
  "status",
  "archivedAt",
  "version",
  "createdAt",
  "updatedAt",
];
const ADDRESS_KEYS = [
  "id",
  "partyId",
  "addressType",
  "line1",
  "line2",
  "line3",
  "city",
  "region",
  "postalCode",
  "countryCode",
  "status",
  "archivedAt",
  "version",
  "createdAt",
  "updatedAt",
];
const CANDIDATE_KEYS = ["partyId", "partyType", "matchReasons"];

type OpenApiSchema = {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  additionalProperties?: boolean | OpenApiSchema;
  items?: OpenApiSchema;
  enum?: unknown[];
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
};

type OpenApiDoc = {
  components?: { schemas?: Record<string, OpenApiSchema> };
  paths: Record<string, Record<string, unknown>>;
};

const OPENAPI_DOC = loadYaml(
  readFileSync(join(process.cwd(), "openapi.yaml"), "utf8"),
) as OpenApiDoc;

function resolveOpenApiSchema(
  doc: OpenApiDoc,
  schema: OpenApiSchema | undefined,
): OpenApiSchema {
  if (!schema?.$ref) return schema ?? {};
  const prefix = "#/components/schemas/";
  if (!schema.$ref.startsWith(prefix)) {
    throw new Error(`Unsupported OpenAPI $ref ${schema.$ref}`);
  }
  const name = schema.$ref.slice(prefix.length);
  const resolved = doc.components?.schemas?.[name];
  if (!resolved) throw new Error(`Missing OpenAPI schema ${name}`);
  return resolved;
}

function jsonTypeNames(value: unknown): string[] {
  if (value === null) return ["null"];
  if (Array.isArray(value)) return ["array"];
  if (typeof value === "number") {
    return Number.isInteger(value) ? ["integer", "number"] : ["number"];
  }
  return [typeof value];
}

function typeAllowed(schemaType: string | string[] | undefined, value: unknown): boolean {
  if (schemaType === undefined) return true;
  const allowed = Array.isArray(schemaType) ? schemaType : [schemaType];
  const actual = jsonTypeNames(value);
  return allowed.some((type) => actual.includes(type));
}

function validateOpenApiValue(
  doc: OpenApiDoc,
  schema: OpenApiSchema | undefined,
  value: unknown,
  path: string,
): string[] {
  const resolved = resolveOpenApiSchema(doc, schema);
  if (resolved.oneOf) {
    const branchErrors = resolved.oneOf.map((branch) =>
      validateOpenApiValue(doc, branch, value, path),
    );
    if (branchErrors.some((errors) => errors.length === 0)) return [];
    return [`${path}: no oneOf branch matched`];
  }
  if (resolved.anyOf) {
    const branchErrors = resolved.anyOf.map((branch) =>
      validateOpenApiValue(doc, branch, value, path),
    );
    if (branchErrors.some((errors) => errors.length === 0)) return [];
    return [`${path}: no anyOf branch matched`];
  }
  const errors: string[] = [];
  if (!typeAllowed(resolved.type, value)) {
    errors.push(`${path}: expected type ${JSON.stringify(resolved.type)}`);
    return errors;
  }
  if (resolved.enum) {
    const matched = resolved.enum.some((item) => Object.is(item, value));
    if (!matched) errors.push(`${path}: value not in enum`);
  }
  if (value === null || typeof value !== "object") return errors;
  if (Array.isArray(value)) {
    const itemSchema = resolved.items;
    value.forEach((item, index) => {
      errors.push(...validateOpenApiValue(doc, itemSchema, item, `${path}[${index}]`));
    });
    return errors;
  }
  const rec = value as Record<string, unknown>;
  for (const key of resolved.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(rec, key)) {
      errors.push(`${path}: missing required ${key}`);
    }
  }
  const additional = resolved.additionalProperties;
  for (const [key, child] of Object.entries(rec)) {
    const property = resolved.properties?.[key];
    if (property) {
      errors.push(...validateOpenApiValue(doc, property, child, `${path}.${key}`));
      continue;
    }
    if (additional === false) {
      errors.push(`${path}: additional property ${key}`);
    } else if (additional && typeof additional === "object") {
      errors.push(...validateOpenApiValue(doc, additional, child, `${path}.${key}`));
    }
  }
  return errors;
}

function openApiSuccessSchema(operationId: string): OpenApiSchema {
  for (const pathItem of Object.values(OPENAPI_DOC.paths)) {
    for (const op of Object.values(pathItem)) {
      if (!op || typeof op !== "object" || Array.isArray(op)) continue;
      const rec = op as {
        operationId?: string;
        responses?: Record<
          string,
          { content?: { "application/json"?: { schema?: OpenApiSchema } } }
        >;
      };
      if (rec.operationId !== operationId) continue;
      const success = rec.responses?.["200"] ?? rec.responses?.["201"];
      const schema = success?.content?.["application/json"]?.schema;
      if (!schema) throw new Error(`OpenAPI operation ${operationId} has no 2xx schema`);
      return schema;
    }
  }
  throw new Error(`OpenAPI operation ${operationId} not found`);
}

function assertHasKeys(label: string, value: unknown, keys: string[]) {
  expect(value, label).toBeTruthy();
  expect(typeof value, label).toBe("object");
  const rec = value as Record<string, unknown>;
  for (const key of keys) {
    expect(Object.prototype.hasOwnProperty.call(rec, key), `${label}.${key}`).toBe(true);
  }
}

function assertEnvelope(
  label: string,
  body: Record<string, unknown>,
  dataKeys: string[],
) {
  expect(Object.prototype.hasOwnProperty.call(body, "data"), `${label} data`).toBe(true);
  assertHasKeys(`${label}.data`, body.data, dataKeys);
}

function assertMatchesOpenApi(
  operationId: string,
  body: Record<string, unknown>,
  dataKeys: string[],
) {
  assertEnvelope(operationId, body, dataKeys);
  const schema = openApiSuccessSchema(operationId);
  const errors = validateOpenApiValue(OPENAPI_DOC, schema, body, operationId);
  expect(errors, `${operationId} nested OpenAPI`).toEqual([]);
  expect(schema.required, `${operationId} OpenAPI envelope`).toEqual(["data"]);
  expect(
    [
      ...(resolveOpenApiSchema(OPENAPI_DOC, schema.properties?.data).required ?? []),
    ].sort(),
    `${operationId} OpenAPI data keys`,
  ).toEqual([...dataKeys].sort());
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
): AuditChainLink[] {
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

async function listAudit(tenantId: string, legalEntityIds: ReadonlySet<string>) {
  return withTenantContext({ tenantId, legalEntityIds: new Set(legalEntityIds) }, (tx) =>
    tx.auditEvent.findMany({
      where: { tenantId },
      orderBy: { sequence: "asc" },
    }),
  );
}

describe("P2D.2a party APIs", () => {
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

  async function boot() {
    fixture = await setupPartyDomainFixture();
    partyApiAuth.userId = fixture.setup.adminUserId;
    return fixture;
  }

  it("covers the 17 happy paths, duplicate shaping, malformed JSON, stale versions, audit, rollback, limiter and transfer concurrency", async () => {
    const { setup, leA, leB, ctxAB } = await boot();
    const tenantId = setup.tenantId;
    const params = { tenantId };
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const createRequestId = uniqueSlug("rid-create");
    const forgedActor = "forged-acting-user";
    const forgedRequestId = "forged-request-id";
    const forgedIp = "203.0.113.9";

    const createdRes = await invoke(
      listCreatePost,
      request(`${base}/parties`, {
        method: "POST",
        headers: { "x-request-id": createRequestId },
        json: {
          ownerLegalEntityId: leA.id,
          code: partyCode(),
          partyType: "ORGANISATION",
          legalName: "Api Co",
          customerRole: { code: partyCode("CUST") },
          vendorRole: { code: partyCode("VEND") },
          actingUserId: forgedActor,
          requestId: forgedRequestId,
          ipAddress: forgedIp,
          tenantId: "forged-tenant",
          legalEntityIds: [leB.id],
          permissions: ["party:create"],
        },
      }),
      params,
    );
    expect(createdRes.status).toBe(201);
    const createdBody = await readJson(createdRes);
    assertMatchesOpenApi("createParty", createdBody, [
      "party",
      "assignment",
      "customerRole",
      "vendorRole",
      "duplicateCandidates",
    ]);
    const created = createdBody.data as {
      party: { id: string; version: number; ownerLegalEntityId: string };
      assignment: { id: string; legalEntityId: string };
      customerRole: { defaultCurrency: string | null } | null;
      vendorRole: { defaultCurrency: string | null } | null;
      duplicateCandidates: unknown[];
    };
    assertHasKeys("createParty.party", created.party, PARTY_KEYS);
    assertHasKeys("createParty.assignment", created.assignment, ASSIGNMENT_KEYS);
    expect(created.party.ownerLegalEntityId).toBe(leA.id);
    expect(created.assignment.legalEntityId).toBe(leA.id);
    expect(created.customerRole).not.toBeNull();
    expect(created.vendorRole).not.toBeNull();
    assertHasKeys("createParty.customerRole", created.customerRole, ROLE_KEYS);
    assertHasKeys("createParty.vendorRole", created.vendorRole, ROLE_KEYS);
    expect(created.customerRole!.defaultCurrency).toBeNull();
    expect(created.vendorRole!.defaultCurrency).toBeNull();
    const partyRoleSchema = OPENAPI_DOC.components?.schemas?.PartyRole;
    expect(partyRoleSchema).toBeDefined();
    const brokenCurrencySchema: OpenApiSchema = {
      ...partyRoleSchema!,
      properties: {
        ...partyRoleSchema!.properties,
        defaultCurrency: { type: ["string", "null"], enum: ["SGD", "MYR", "IDR"] },
      },
    };
    expect(
      validateOpenApiValue(
        OPENAPI_DOC,
        brokenCurrencySchema,
        created.customerRole,
        "broken-customerRole",
      ).some((error) => error.includes("enum")),
    ).toBe(true);
    expect(
      validateOpenApiValue(
        OPENAPI_DOC,
        partyRoleSchema,
        created.customerRole,
        "customerRole",
      ),
    ).toEqual([]);
    expect(Array.isArray(created.duplicateCandidates)).toBe(true);
    for (const row of created.duplicateCandidates) {
      assertHasKeys("createParty.candidate", row, CANDIDATE_KEYS);
    }
    const partyId = created.party.id;

    const listedRes = await invoke(listCreateGet, request(`${base}/parties`), params);
    expect(listedRes.status).toBe(200);
    const listedBody = await readJson(listedRes);
    assertMatchesOpenApi("listParties", listedBody, ["parties", "nextCursor"]);

    const getRes = await invoke(partyGet, request(`${base}/parties/${partyId}`), {
      ...params,
      partyId,
    });
    expect(getRes.status).toBe(200);
    const getBody = await readJson(getRes);
    assertMatchesOpenApi("getParty", getBody, ["party"]);
    assertHasKeys(
      "getParty.party",
      (getBody.data as { party: unknown }).party,
      PARTY_KEYS,
    );

    const patched = await invoke(
      partyPatch,
      request(`${base}/parties/${partyId}`, {
        method: "PATCH",
        json: { expectedVersion: created.party.version, tradingName: "Traded" },
      }),
      { ...params, partyId },
    );
    expect(patched.status).toBe(200);
    const patchedBody = await readJson(patched);
    assertMatchesOpenApi("updateParty", patchedBody, ["party"]);
    const patchedParty = (patchedBody.data as { party: { version: number } }).party;

    const staleUpdate = await invoke(
      partyPatch,
      request(`${base}/parties/${partyId}`, {
        method: "PATCH",
        json: { expectedVersion: created.party.version, tradingName: "Stale" },
      }),
      { ...params, partyId },
    );
    expect(staleUpdate.status).toBe(409);
    expect(((await readJson(staleUpdate)).error as { code: string }).code).toBe(
      "STALE_VERSION",
    );

    const contactCreate = await invoke(
      contactsPost,
      request(`${base}/parties/${partyId}/contacts`, {
        method: "POST",
        json: { givenName: "Pat", email: "pat@api.example", phone: "111" },
      }),
      { ...params, partyId },
    );
    expect(contactCreate.status).toBe(201);
    const contactCreateBody = await readJson(contactCreate);
    assertMatchesOpenApi("createPartyContact", contactCreateBody, ["contact"]);
    const contact = (
      contactCreateBody.data as {
        contact: {
          id: string;
          version: number;
          email: string | null;
          phone: string | null;
        };
      }
    ).contact;
    assertHasKeys("createPartyContact.contact", contact, CONTACT_KEYS);
    expect(Object.prototype.hasOwnProperty.call(contact, "email")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(contact, "phone")).toBe(true);

    const contactsListRes = await invoke(
      contactsGet,
      request(`${base}/parties/${partyId}/contacts`),
      { ...params, partyId },
    );
    expect(contactsListRes.status).toBe(200);
    const contactsListBody = await readJson(contactsListRes);
    assertMatchesOpenApi("listPartyContacts", contactsListBody, [
      "contacts",
      "nextCursor",
    ]);
    const contactGetRes = await invoke(
      contactGet,
      request(`${base}/party-contacts/${contact.id}`),
      { ...params, contactId: contact.id },
    );
    expect(contactGetRes.status).toBe(200);
    const contactGetBody = await readJson(contactGetRes);
    assertMatchesOpenApi("getPartyContact", contactGetBody, ["contact"]);

    const contactUpdated = await invoke(
      contactPatch,
      request(`${base}/party-contacts/${contact.id}`, {
        method: "PATCH",
        json: { expectedVersion: contact.version, jobTitle: "Buyer" },
      }),
      { ...params, contactId: contact.id },
    );
    expect(contactUpdated.status).toBe(200);
    const contactUpdatedBody = await readJson(contactUpdated);
    assertMatchesOpenApi("updatePartyContact", contactUpdatedBody, ["contact"]);
    const contactAfter = (contactUpdatedBody.data as { contact: { version: number } })
      .contact;

    const addressCreate = await invoke(
      addressesPost,
      request(`${base}/parties/${partyId}/addresses`, {
        method: "POST",
        json: { addressType: "GENERAL", line1: "1 Street", countryCode: "SG" },
      }),
      { ...params, partyId },
    );
    expect(addressCreate.status).toBe(201);
    const addressCreateBody = await readJson(addressCreate);
    assertMatchesOpenApi("createPartyAddress", addressCreateBody, ["address"]);
    const address = (
      addressCreateBody.data as { address: { id: string; version: number } }
    ).address;
    assertHasKeys("createPartyAddress.address", address, ADDRESS_KEYS);
    const addressesListRes = await invoke(
      addressesGet,
      request(`${base}/parties/${partyId}/addresses`),
      { ...params, partyId },
    );
    expect(addressesListRes.status).toBe(200);
    assertMatchesOpenApi("listPartyAddresses", await readJson(addressesListRes), [
      "addresses",
      "nextCursor",
    ]);
    const addressGetRes = await invoke(
      addressGet,
      request(`${base}/party-addresses/${address.id}`),
      { ...params, addressId: address.id },
    );
    expect(addressGetRes.status).toBe(200);
    assertMatchesOpenApi("getPartyAddress", await readJson(addressGetRes), ["address"]);
    const addressUpdated = await invoke(
      addressPatch,
      request(`${base}/party-addresses/${address.id}`, {
        method: "PATCH",
        json: { expectedVersion: address.version, city: "Singapore" },
      }),
      { ...params, addressId: address.id },
    );
    expect(addressUpdated.status).toBe(200);
    const addressUpdatedBody = await readJson(addressUpdated);
    assertMatchesOpenApi("updatePartyAddress", addressUpdatedBody, ["address"]);
    const addressAfter = (addressUpdatedBody.data as { address: { version: number } })
      .address;

    const duplicateRes = await invoke(
      duplicatePost,
      request(`${base}/parties/duplicate-candidates`, {
        method: "POST",
        json: { legalName: "Api Co", partyType: "ORGANISATION" },
      }),
      params,
    );
    expect(duplicateRes.status).toBe(200);
    const duplicateBody = await readJson(duplicateRes);
    assertMatchesOpenApi("listPartyDuplicateCandidates", duplicateBody, ["candidates"]);
    for (const row of (duplicateBody.data as { candidates: unknown[] }).candidates) {
      assertHasKeys("duplicate.candidate", row, CANDIDATE_KEYS);
    }

    const beforeMalformed = (await listAudit(tenantId, ctxAB.legalEntityIds)).length;
    const malformed = await invoke(
      listCreatePost,
      new Request(`${base}/parties`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": uniqueSlug("rid"),
        },
        body: "{not-json",
      }),
      params,
    );
    expect(malformed.status).toBe(422);

    const conflictingContact = await invoke(
      contactsPost,
      request(`${base}/parties/${partyId}/contacts`, {
        method: "POST",
        json: { partyId: "other-party", givenName: "Eve" },
      }),
      { ...params, partyId },
    );
    expect(conflictingContact.status).toBe(422);
    expect((await listAudit(tenantId, ctxAB.legalEntityIds)).length).toBe(
      beforeMalformed,
    );

    await createAssignment(ctxAB, { partyId, legalEntityId: leB.id });
    const transferred = await invoke(
      partyTransfer,
      request(`${base}/parties/${partyId}/ownership-transfer`, {
        method: "POST",
        json: { newOwnerLegalEntityId: leB.id, expectedVersion: patchedParty.version },
      }),
      { ...params, partyId },
    );
    expect(transferred.status).toBe(200);
    const transferredBody = await readJson(transferred);
    assertMatchesOpenApi("transferPartyOwnership", transferredBody, ["party"]);
    const transferredParty = (
      transferredBody.data as {
        party: { version: number; ownerLegalEntityId: string };
      }
    ).party;
    expect(transferredParty.ownerLegalEntityId).toBe(leB.id);

    const staleArchive = await invoke(
      partyArchive,
      request(`${base}/parties/${partyId}/archive`, {
        method: "POST",
        json: { expectedVersion: 1 },
      }),
      { ...params, partyId },
    );
    expect(staleArchive.status).toBe(409);

    const auditsBeforeStale = (await listAudit(tenantId, ctxAB.legalEntityIds)).length;
    const staleContact = await invoke(
      contactPatch,
      request(`${base}/party-contacts/${contact.id}`, {
        method: "PATCH",
        json: { expectedVersion: contact.version, jobTitle: "Stale" },
      }),
      { ...params, contactId: contact.id },
    );
    expect(staleContact.status).toBe(409);
    const staleAddress = await invoke(
      addressPatch,
      request(`${base}/party-addresses/${address.id}`, {
        method: "PATCH",
        json: { expectedVersion: address.version, city: "Stale" },
      }),
      { ...params, addressId: address.id },
    );
    expect(staleAddress.status).toBe(409);
    expect(
      (
        await invoke(
          contactArchive,
          request(`${base}/party-contacts/${contact.id}/archive`, {
            method: "POST",
            json: { expectedVersion: contact.version },
          }),
          { ...params, contactId: contact.id },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await invoke(
          addressArchive,
          request(`${base}/party-addresses/${address.id}/archive`, {
            method: "POST",
            json: { expectedVersion: address.version },
          }),
          { ...params, addressId: address.id },
        )
      ).status,
    ).toBe(409);
    expect((await listAudit(tenantId, ctxAB.legalEntityIds)).length).toBe(
      auditsBeforeStale,
    );

    const contactArchivedRes = await invoke(
      contactArchive,
      request(`${base}/party-contacts/${contact.id}/archive`, {
        method: "POST",
        json: { expectedVersion: contactAfter.version },
      }),
      { ...params, contactId: contact.id },
    );
    expect(contactArchivedRes.status).toBe(200);
    assertMatchesOpenApi("archivePartyContact", await readJson(contactArchivedRes), [
      "contact",
    ]);
    const addressArchivedRes = await invoke(
      addressArchive,
      request(`${base}/party-addresses/${address.id}/archive`, {
        method: "POST",
        json: { expectedVersion: addressAfter.version },
      }),
      { ...params, addressId: address.id },
    );
    expect(addressArchivedRes.status).toBe(200);
    assertMatchesOpenApi("archivePartyAddress", await readJson(addressArchivedRes), [
      "address",
    ]);

    const archived = await invoke(
      partyArchive,
      request(`${base}/parties/${partyId}/archive`, {
        method: "POST",
        json: { expectedVersion: transferredParty.version },
      }),
      { ...params, partyId },
    );
    expect(archived.status).toBe(200);
    assertMatchesOpenApi("archiveParty", await readJson(archived), ["party"]);

    const beforeExtra = (await listAudit(tenantId, ctxAB.legalEntityIds)).length;
    const extraBody = await invoke(
      partyArchive,
      request(`${base}/parties/${partyId}/archive`, {
        method: "POST",
        json: { expectedVersion: 99, extra: true },
      }),
      { ...params, partyId },
    );
    expect(extraBody.status).toBe(422);
    expect((await listAudit(tenantId, ctxAB.legalEntityIds)).length).toBe(beforeExtra);

    const forgedCreate = await invoke(
      listCreatePost,
      request(`${base}/parties`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: partyCode(),
          partyType: "ORGANISATION",
          legalName: "Forged Fields Co",
          tenantId: "forged-tenant",
          userId: "forged-user",
          permissions: ["party:create"],
          legalEntityIds: [leB.id],
        },
      }),
      params,
    );
    expect(forgedCreate.status).toBe(201);
    expect(
      ((await readJson(forgedCreate)).data as { party: { ownerLegalEntityId: string } })
        .party.ownerLegalEntityId,
    ).toBe(leA.id);

    const beforeDelete = (await listAudit(tenantId, ctxAB.legalEntityIds)).length;
    const deleteAttempt = await invoke(
      listCreatePost,
      request(`${base}/parties`, { method: "DELETE" }),
      params,
    );
    expect(deleteAttempt.status).toBe(403);
    expect((await listAudit(tenantId, ctxAB.legalEntityIds)).length).toBe(beforeDelete);

    const routeDir = join(process.cwd(), "app/api/v1/tenants/[tenantId]");
    const routeFiles = [
      "parties/route.ts",
      "parties/[partyId]/route.ts",
      "parties/[partyId]/archive/route.ts",
      "parties/[partyId]/ownership-transfer/route.ts",
      "parties/duplicate-candidates/route.ts",
      "parties/[partyId]/contacts/route.ts",
      "party-contacts/[contactId]/route.ts",
      "party-contacts/[contactId]/archive/route.ts",
      "parties/[partyId]/addresses/route.ts",
      "party-addresses/[addressId]/route.ts",
      "party-addresses/[addressId]/archive/route.ts",
    ];
    for (const rel of routeFiles) {
      const source = readFileSync(join(routeDir, rel), "utf8");
      expect(source).not.toMatch(/export const DELETE/);
      expect(source).not.toMatch(/writeAuditEvent/);
      expect(source).not.toMatch(/\$transaction/);
      expect(source).not.toMatch(/\bauthorize\s*\(/);
      expect(source).not.toMatch(/\btenantRoute\s*\(/);
      expect(source).not.toMatch(/\bapiHandler\s*\(/);
      expect(source).not.toMatch(/resolveTenantContext/);
    }

    const audits = await listAudit(tenantId, ctxAB.legalEntityIds);
    const actions = new Set(audits.map((a) => a.action));
    for (const action of [
      AUDIT_ACTIONS.PARTY_CREATED,
      AUDIT_ACTIONS.PARTY_UPDATED,
      AUDIT_ACTIONS.PARTY_ARCHIVED,
      AUDIT_ACTIONS.PARTY_OWNERSHIP_TRANSFERRED,
      AUDIT_ACTIONS.PARTY_CONTACT_CREATED,
      AUDIT_ACTIONS.PARTY_CONTACT_UPDATED,
      AUDIT_ACTIONS.PARTY_CONTACT_ARCHIVED,
      AUDIT_ACTIONS.PARTY_ADDRESS_CREATED,
      AUDIT_ACTIONS.PARTY_ADDRESS_UPDATED,
      AUDIT_ACTIONS.PARTY_ADDRESS_ARCHIVED,
    ]) {
      expect(actions.has(action)).toBe(true);
    }
    const createdAudit = audits.find(
      (a) => a.action === AUDIT_ACTIONS.PARTY_CREATED && a.entityId === partyId,
    );
    expect(createdAudit).toBeDefined();
    expect(createdAudit!.requestId).toBe(createRequestId);
    expect(createdAudit!.actorUserId).toBe(setup.adminUserId);
    const auditText = JSON.stringify(audits, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item,
    );
    expect(auditText).not.toContain(forgedActor);
    expect(auditText).not.toContain(forgedRequestId);
    expect(auditText).not.toContain(forgedIp);
    expect(auditText).not.toContain("forged-tenant");
    expect(auditText).not.toContain("pat@api.example");
    const chain = verifyAuditChain(toLinks(audits));
    expect(chain.valid).toBe(true);
    const sequences = audits.map((a) => Number(a.sequence));
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBe(sequences[i - 1]! + 1);
    }

    const beforeConflict = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) => tx.party.count({ where: { tenantId } }),
    );
    const conflict = await invoke(
      listCreatePost,
      request(`${base}/parties`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: (getBody.data as { party: { code: string } }).party.code,
          partyType: "ORGANISATION",
          legalName: "Dup Code",
        },
      }),
      params,
    );
    expect(conflict.status).toBe(409);
    const afterConflict = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) => tx.party.count({ where: { tenantId } }),
    );
    expect(afterConflict).toBe(beforeConflict);
    expect((await listAudit(tenantId, ctxAB.legalEntityIds)).length).toBe(audits.length);
  }, 60_000);

  it("returns 429 when the shared write limiter is exhausted and does not call the domain write", async () => {
    const { setup, leA, ctxAB } = await boot();
    const tenantId = setup.tenantId;
    const userId = setup.adminUserId;
    const before = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) => tx.party.count({ where: { tenantId } }),
    );
    for (let i = 0; i < API_WRITE_MAX_PER_TENANT_USER; i++) {
      expect(await consumeApiWriteAllowance({ tenantId, userId })).toBe("ok");
    }
    const limited = await invoke(
      listCreatePost,
      request(`https://noahark.example/api/v1/tenants/${tenantId}/parties`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: partyCode(),
          partyType: "ORGANISATION",
          legalName: "Limited Co",
        },
      }),
      { tenantId },
    );
    expect(limited.status).toBe(429);
    expect(((await readJson(limited)).error as { code: string }).code).toBe(
      "RATE_LIMITED",
    );
    const after = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) => tx.party.count({ where: { tenantId } }),
    );
    expect(after).toBe(before);
  }, 60_000);

  it("lets exactly one of two concurrent ownership transfers succeed", async () => {
    const { setup, leA, leB, ctxAB } = await boot();
    const tenantId = setup.tenantId;
    const createdRes = await invoke(
      listCreatePost,
      request(`https://noahark.example/api/v1/tenants/${tenantId}/parties`, {
        method: "POST",
        json: {
          ownerLegalEntityId: leA.id,
          code: partyCode(),
          partyType: "ORGANISATION",
          legalName: "Race Co",
          customerRole: { code: partyCode("CUST") },
        },
      }),
      { tenantId },
    );
    const created = (
      (await readJson(createdRes)).data as {
        party: { id: string; version: number };
        customerRole: { id: string; status: string; code: string } | null;
        vendorRole: null;
      }
    ).party;
    await createAssignment(ctxAB, { partyId: created.id, legalEntityId: leB.id });
    const before = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        party: await tx.party.findFirstOrThrow({ where: { id: created.id } }),
        assignments: await tx.partyLegalEntityAssignment.findMany({
          where: { partyId: created.id },
          orderBy: { id: "asc" },
        }),
        customer: await tx.customerRole.findMany({
          where: { assignment: { partyId: created.id } },
          orderBy: { id: "asc" },
        }),
        vendor: await tx.vendorRole.findMany({
          where: { assignment: { partyId: created.id } },
          orderBy: { id: "asc" },
        }),
      }),
    );
    const makeTransfer = () =>
      invoke(
        partyTransfer,
        request(
          `https://noahark.example/api/v1/tenants/${tenantId}/parties/${created.id}/ownership-transfer`,
          {
            method: "POST",
            json: {
              newOwnerLegalEntityId: leB.id,
              expectedVersion: created.version,
            },
          },
        ),
        { tenantId, partyId: created.id },
      );
    const pendingFirst = makeTransfer();
    const pendingSecond = makeTransfer();
    const settled = await Promise.allSettled([pendingFirst, pendingSecond]);
    expect(settled.every((row) => row.status === "fulfilled")).toBe(true);
    const results = settled.map((row) => (row as PromiseFulfilledResult<Response>).value);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    const conflictBody = await readJson(results.find((r) => r.status === 409)!);
    expect((conflictBody.error as { code: string }).code).toBe("STALE_VERSION");
    const after = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => ({
        party: await tx.party.findFirstOrThrow({ where: { id: created.id } }),
        assignments: await tx.partyLegalEntityAssignment.findMany({
          where: { partyId: created.id },
          orderBy: { id: "asc" },
        }),
        customer: await tx.customerRole.findMany({
          where: { assignment: { partyId: created.id } },
          orderBy: { id: "asc" },
        }),
        vendor: await tx.vendorRole.findMany({
          where: { assignment: { partyId: created.id } },
          orderBy: { id: "asc" },
        }),
      }),
    );
    expect(after.party.version).toBe(before.party.version + 1);
    expect(after.party.ownerLegalEntityId).toBe(leB.id);
    expect(after.assignments.map((row) => row.id)).toEqual(
      before.assignments.map((row) => row.id),
    );
    expect(after.assignments.map((row) => row.legalEntityId)).toEqual(
      before.assignments.map((row) => row.legalEntityId),
    );
    expect(after.assignments.map((row) => row.status)).toEqual(
      before.assignments.map((row) => row.status),
    );
    expect(
      after.customer.map((row) => ({ id: row.id, status: row.status, code: row.code })),
    ).toEqual(
      before.customer.map((row) => ({ id: row.id, status: row.status, code: row.code })),
    );
    expect(after.vendor.map((row) => row.id)).toEqual(before.vendor.map((row) => row.id));
    const audits = await listAudit(tenantId, ctxAB.legalEntityIds);
    const transfers = audits.filter(
      (a) => a.action === AUDIT_ACTIONS.PARTY_OWNERSHIP_TRANSFERRED,
    );
    expect(transfers).toHaveLength(1);
    expect(transfers[0]!.beforeData).toEqual({
      ownerLegalEntityId: leA.id,
      version: before.party.version,
    });
    expect(transfers[0]!.afterData).toEqual({
      ownerLegalEntityId: leB.id,
      version: before.party.version + 1,
    });
    expect(Object.keys(transfers[0]!.beforeData as object).sort()).toEqual([
      "ownerLegalEntityId",
      "version",
    ]);
    expect(Object.keys(transfers[0]!.afterData as object).sort()).toEqual([
      "ownerLegalEntityId",
      "version",
    ]);
    const sequences = audits.map((a) => Number(a.sequence));
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBe(sequences[i - 1]! + 1);
    }
    expect(verifyAuditChain(toLinks(audits)).valid).toBe(true);
  }, 60_000);
});
