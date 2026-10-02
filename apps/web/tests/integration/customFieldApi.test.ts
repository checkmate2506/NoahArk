import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import type { AccessContext } from "@noahark/core";
import { AUDIT_ACTIONS, verifyAuditChain } from "@noahark/audit";
import { withTenantContext } from "@noahark/db";
import { createSystemClient } from "@noahark/db/system";
import {
  GET as definitionsGet,
  POST as definitionsPost,
} from "@/app/api/v1/tenants/[tenantId]/custom-fields/definitions/route";
import {
  GET as definitionGet,
  PATCH as definitionPatch,
} from "@/app/api/v1/tenants/[tenantId]/custom-fields/definitions/[definitionId]/route";
import { POST as definitionDeactivate } from "@/app/api/v1/tenants/[tenantId]/custom-fields/definitions/[definitionId]/deactivate/route";
import { POST as definitionActivate } from "@/app/api/v1/tenants/[tenantId]/custom-fields/definitions/[definitionId]/activate/route";
import {
  GET as valuesGet,
  PUT as valuesPut,
} from "@/app/api/v1/tenants/[tenantId]/custom-fields/values/route";
import { GET as valueGet } from "@/app/api/v1/tenants/[tenantId]/custom-fields/values/[valueId]/route";
import { cleanupTenant, cleanupUser, uniqueSlug } from "./testHelpers";
import {
  createTestParty,
  fieldKey,
  setupCustomFieldDomainFixture,
  type CustomFieldDomainFixture,
} from "./customFieldDomainFixture";
import {
  OPENAPI_DOC,
  type OpenApiSchema,
  assertMatchesOpenApi,
  validateOpenApiValue,
} from "./openapiResponseValidator";

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROUTE_ROOT = join(WEB_ROOT, "app/api/v1/tenants/[tenantId]/custom-fields");

const { customFieldApiAuth } = vi.hoisted(() => ({
  customFieldApiAuth: { userId: undefined as string | undefined },
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
      if (!customFieldApiAuth.userId) throw new UnauthenticatedError();
      return actual.getAccessContext(
        customFieldApiAuth.userId,
        tenantId,
        actual.requestMeta(req, requestId),
      );
    },
  };
});

type Definition = {
  id: string;
  legalEntityId: null;
  entityType: string;
  key: string;
  label: string;
  dataType: string;
  isRequired: boolean;
  options: string[] | null;
  isActive: boolean;
  displayOrder: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type FieldValue = {
  id: string;
  legalEntityId: string;
  definitionId: string;
  entityType: string;
  entityId: string;
  version: number;
  typedValue: { dataType: string; value: unknown };
};

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

function asDefinition(body: Record<string, unknown>): Definition {
  return (body.data as { definition: Definition }).definition;
}

function asValue(body: Record<string, unknown>): FieldValue {
  return (body.data as { value: FieldValue }).value;
}

function collectRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectRouteFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

function valueLockKey(tenantId: string, definitionId: string, entityId: string): string {
  return `custom-field-value:${tenantId}:${definitionId}:${entityId}`;
}

async function holdTx(
  ctx: AccessContext,
  acquire: (client: pg.Client) => Promise<void>,
  whileHeld: () => Promise<void>,
  then: (client: pg.Client) => Promise<void> = async () => undefined,
): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
    await client.query("SELECT set_config('app.legal_entity_ids', $1, true)", [
      Array.from(ctx.legalEntityIds).join(","),
    ]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [ctx.userId]);
    await acquire(client);
    await whileHeld();
    await then(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function waitUntil(sql: string, label: string, minimum = 1): Promise<void> {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error("DATABASE_MIGRATION_URL is not set");
  const observer = new pg.Client({ connectionString: url });
  await observer.connect();
  try {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const result = await observer.query<{ n: string }>(sql);
      if (Number(result.rows[0]?.n ?? 0) >= minimum) return;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`timed out waiting for ${label}`);
  } finally {
    await observer.end();
  }
}

function waitUntilAdvisoryWaiters(minimum = 1): Promise<void> {
  return waitUntil(
    `SELECT count(*)::text AS n
     FROM pg_locks
     WHERE locktype = 'advisory' AND NOT granted`,
    `${minimum} blocked advisory lock(s)`,
    minimum,
  );
}

describe("P2D.4 custom-field APIs", () => {
  let fixture: CustomFieldDomainFixture | undefined;

  afterEach(async () => {
    customFieldApiAuth.userId = undefined;
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("enforces custom-field route and OpenAPI structural contracts", () => {
    const routes = collectRouteFiles(ROUTE_ROOT);
    expect(routes).toHaveLength(6);
    const combined = [
      ...routes.map((file) => readFileSync(file, "utf8")),
      readFileSync(join(WEB_ROOT, "lib/services/customFieldDomain.ts"), "utf8"),
    ].join("\n");
    const banned = [
      "export const DELETE",
      "@noahark/db/system",
      "@noahark/db/worker",
      "createSystemClient",
      "createWorkerClient",
      "$transaction",
      "sqlState",
      "originalCode",
      "driverAdapterError",
      "23P01",
      "23505",
      "P2002",
      "tenantReadPostRoute",
      "demo_approval_subject",
      "MULTI_SELECT",
      "NUMBER",
    ];
    for (const token of banned) {
      expect(combined, token).not.toContain(token);
    }
    expect(combined).not.toMatch(/\bPrisma\b/);
    const yaml = readFileSync(join(WEB_ROOT, "openapi.yaml"), "utf8");
    expect(yaml).not.toMatch(/\bexport const DELETE\b/);
    expect(yaml).not.toContain("demo_approval_subject");
    expect(yaml).toContain("operationId: listCustomFieldDefinitions");
    expect(yaml).toContain("operationId: setCustomFieldValue");
    expect(yaml).not.toMatch(/\/custom-fields\/values\/\{valueId\}:\s*\n\s+delete:/);
  });

  it("covers definition and value lifecycle, validation, pagination and OpenAPI", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { setup, ctxAB, leA } = fixture;
    const tenantId = setup.tenantId;
    const userId = setup.adminUserId;
    customFieldApiAuth.userId = userId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const party = await createTestParty(ctxAB, leA.id);
    const key = fieldKey("note");
    const createRequestId = uniqueSlug("rid");

    const createdRes = await invoke(
      definitionsPost,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        headers: { "x-request-id": createRequestId },
        json: {
          entityType: "party",
          key,
          label: "Note",
          dataType: "STRING",
        },
      }),
      { tenantId },
    );
    expect(createdRes.status).toBe(201);
    const createdBody = await readJson(createdRes);
    assertMatchesOpenApi("createCustomFieldDefinition", createdBody, ["definition"]);
    const definition = asDefinition(createdBody);
    expect(definition.legalEntityId).toBeNull();
    expect(definition.entityType).toBe("party");
    expect(definition.key).toBe(key);
    expect(definition.isActive).toBe(true);
    expect(definition.version).toBe(1);
    expect(definition).not.toHaveProperty("tenantId");

    const rejected = [
      {
        legalEntityId: leA.id,
        entityType: "party",
        key: fieldKey("x"),
        label: "X",
        dataType: "STRING",
      },
      {
        tenantId,
        entityType: "party",
        key: fieldKey("x"),
        label: "X",
        dataType: "STRING",
      },
      {
        extra: true,
        entityType: "party",
        key: fieldKey("x"),
        label: "X",
        dataType: "STRING",
      },
      {
        entityType: "demo_approval_subject",
        key: fieldKey("x"),
        label: "X",
        dataType: "STRING",
      },
      { entityType: "party", key: fieldKey("x"), label: "X", dataType: "NUMBER" },
      { entityType: "party", key: fieldKey("x"), label: "X", dataType: "MULTI_SELECT" },
    ];
    for (const json of rejected) {
      const res = await invoke(
        definitionsPost,
        request(`${base}/custom-fields/definitions`, { method: "POST", json }),
        { tenantId },
      );
      expect(res.status, JSON.stringify(json)).toBe(422);
    }

    const duplicate = await invoke(
      definitionsPost,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: { entityType: "party", key, label: "Dup", dataType: "STRING" },
      }),
      { tenantId },
    );
    expect(duplicate.status).toBe(409);
    expect(errorCode(await readJson(duplicate))).toBe("CONFLICT");

    const listRes = await invoke(
      definitionsGet,
      request(`${base}/custom-fields/definitions`),
      { tenantId },
    );
    expect(listRes.status).toBe(200);
    const listBody = await readJson(listRes);
    assertMatchesOpenApi("listCustomFieldDefinitions", listBody, [
      "definitions",
      "nextCursor",
    ]);
    expect(
      (listBody.data as { definitions: Array<{ id: string }> }).definitions.some(
        (row) => row.id === definition.id,
      ),
    ).toBe(true);

    const getRes = await invoke(
      definitionGet,
      request(`${base}/custom-fields/definitions/${definition.id}`),
      { tenantId, definitionId: definition.id },
    );
    expect(getRes.status).toBe(200);
    assertMatchesOpenApi("getCustomFieldDefinition", await readJson(getRes), [
      "definition",
    ]);

    const updatedRes = await invoke(
      definitionPatch,
      request(`${base}/custom-fields/definitions/${definition.id}`, {
        method: "PATCH",
        json: { expectedVersion: definition.version, label: "Note renamed" },
      }),
      { tenantId, definitionId: definition.id },
    );
    expect(updatedRes.status).toBe(200);
    const updatedBody = await readJson(updatedRes);
    assertMatchesOpenApi("updateCustomFieldDefinition", updatedBody, ["definition"]);
    const updated = asDefinition(updatedBody);
    expect(updated.label).toBe("Note renamed");
    expect(updated.key).toBe(key);
    expect(updated.version).toBe(2);

    for (const json of [
      { expectedVersion: updated.version, entityType: "catalog_item" },
      { expectedVersion: updated.version, key: "other" },
      { expectedVersion: updated.version, dataType: "INTEGER" },
      { expectedVersion: updated.version, legalEntityId: leA.id },
      { expectedVersion: updated.version, tenantId },
    ]) {
      const res = await invoke(
        definitionPatch,
        request(`${base}/custom-fields/definitions/${definition.id}`, {
          method: "PATCH",
          json,
        }),
        { tenantId, definitionId: definition.id },
      );
      expect(res.status, JSON.stringify(json)).toBe(422);
    }

    const stale = await invoke(
      definitionPatch,
      request(`${base}/custom-fields/definitions/${definition.id}`, {
        method: "PATCH",
        json: { expectedVersion: 1, label: "Stale" },
      }),
      { tenantId, definitionId: definition.id },
    );
    expect(stale.status).toBe(409);
    const staleBody = await readJson(stale);
    expect(errorCode(staleBody)).toBe("STALE_VERSION");

    const selectRes = await invoke(
      definitionsPost,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: {
          entityType: "party",
          key: fieldKey("color"),
          label: "Color",
          dataType: "SINGLE_SELECT",
          options: ["red", "blue"],
        },
      }),
      { tenantId },
    );
    expect(selectRes.status).toBe(201);
    const selectDef = asDefinition(await readJson(selectRes));
    const removeOption = await invoke(
      definitionPatch,
      request(`${base}/custom-fields/definitions/${selectDef.id}`, {
        method: "PATCH",
        json: { expectedVersion: selectDef.version, options: ["red"] },
      }),
      { tenantId, definitionId: selectDef.id },
    );
    expect(removeOption.status).toBe(422);

    const setRes = await invoke(
      valuesPut,
      request(`${base}/custom-fields/values`, {
        method: "PUT",
        json: {
          definitionId: definition.id,
          entityId: party.party.id,
          value: { dataType: "STRING", value: "  hello  " },
        },
      }),
      { tenantId },
    );
    expect(setRes.status).toBe(200);
    const setBody = await readJson(setRes);
    assertMatchesOpenApi("setCustomFieldValue", setBody, ["value"]);
    const written = asValue(setBody);
    expect(written.typedValue).toEqual({ dataType: "STRING", value: "hello" });
    expect(written.legalEntityId).toBe(leA.id);
    expect(written.entityType).toBe("party");
    expect(written).not.toHaveProperty("tenantId");

    for (const json of [
      {
        definitionId: definition.id,
        entityId: party.party.id,
        value: { dataType: "STRING", value: "x" },
        legalEntityId: leA.id,
      },
      {
        definitionId: definition.id,
        entityId: party.party.id,
        value: { dataType: "STRING", value: "x" },
        tenantId,
      },
      {
        definitionId: definition.id,
        entityId: party.party.id,
        value: { dataType: "STRING", value: "x" },
        entityType: "party",
      },
      {
        definitionId: definition.id,
        entityId: party.party.id,
        value: { dataType: "STRING", value: "x" },
        expectedVersion: 1,
      },
      { definitionId: definition.id, entityId: party.party.id, value: null },
      {
        definitionId: definition.id,
        entityId: party.party.id,
        extra: true,
        value: { dataType: "STRING", value: "x" },
      },
    ]) {
      const res = await invoke(
        valuesPut,
        request(`${base}/custom-fields/values`, { method: "PUT", json }),
        { tenantId },
      );
      expect(res.status, JSON.stringify(json)).toBe(422);
    }

    const getValueRes = await invoke(
      valueGet,
      request(`${base}/custom-fields/values/${written.id}`),
      { tenantId, valueId: written.id },
    );
    expect(getValueRes.status).toBe(200);
    assertMatchesOpenApi("getCustomFieldValue", await readJson(getValueRes), ["value"]);

    const listValuesRes = await invoke(
      valuesGet,
      request(
        `${base}/custom-fields/values?definitionId=${written.definitionId}&entityId=${party.party.id}`,
      ),
      { tenantId },
    );
    expect(listValuesRes.status).toBe(200);
    const listValuesBody = await readJson(listValuesRes);
    assertMatchesOpenApi("listCustomFieldValues", listValuesBody, [
      "values",
      "nextCursor",
    ]);
    expect(
      (listValuesBody.data as { values: Array<{ id: string }> }).values,
    ).toHaveLength(1);

    const overwrite = await invoke(
      valuesPut,
      request(`${base}/custom-fields/values`, {
        method: "PUT",
        json: {
          definitionId: definition.id,
          entityId: party.party.id,
          value: { dataType: "STRING", value: "second" },
        },
      }),
      { tenantId },
    );
    expect(overwrite.status).toBe(200);
    expect(asValue(await readJson(overwrite)).id).toBe(written.id);

    const deactivatedRes = await invoke(
      definitionDeactivate,
      request(`${base}/custom-fields/definitions/${definition.id}/deactivate`, {
        method: "POST",
        json: { expectedVersion: updated.version },
      }),
      { tenantId, definitionId: definition.id },
    );
    expect(deactivatedRes.status).toBe(200);
    const deactivatedBody = await readJson(deactivatedRes);
    assertMatchesOpenApi("deactivateCustomFieldDefinition", deactivatedBody, [
      "definition",
    ]);
    const deactivated = asDefinition(deactivatedBody);
    expect(deactivated.isActive).toBe(false);

    const defaultList = await invoke(
      definitionsGet,
      request(`${base}/custom-fields/definitions`),
      { tenantId },
    );
    const defaultIds = (
      (await readJson(defaultList)).data as { definitions: Array<{ id: string }> }
    ).definitions.map((row) => row.id);
    expect(defaultIds).not.toContain(definition.id);

    const inactiveList = await invoke(
      definitionsGet,
      request(`${base}/custom-fields/definitions?isActive=false`),
      { tenantId },
    );
    const inactiveIds = (
      (await readJson(inactiveList)).data as { definitions: Array<{ id: string }> }
    ).definitions.map((row) => row.id);
    expect(inactiveIds).toContain(definition.id);

    const alreadyInactive = await invoke(
      definitionDeactivate,
      request(`${base}/custom-fields/definitions/${definition.id}/deactivate`, {
        method: "POST",
        json: { expectedVersion: deactivated.version },
      }),
      { tenantId, definitionId: definition.id },
    );
    expect(alreadyInactive.status).toBe(422);

    const inactiveSet = await invoke(
      valuesPut,
      request(`${base}/custom-fields/values`, {
        method: "PUT",
        json: {
          definitionId: definition.id,
          entityId: party.party.id,
          value: { dataType: "STRING", value: "blocked" },
        },
      }),
      { tenantId },
    );
    expect(inactiveSet.status).toBe(409);
    expect(errorCode(await readJson(inactiveSet))).toBe("CONFLICT");

    const stillReadable = await invoke(
      valueGet,
      request(`${base}/custom-fields/values/${written.id}`),
      { tenantId, valueId: written.id },
    );
    expect(stillReadable.status).toBe(200);
    expect(asValue(await readJson(stillReadable)).typedValue).toEqual({
      dataType: "STRING",
      value: "second",
    });

    const activatedRes = await invoke(
      definitionActivate,
      request(`${base}/custom-fields/definitions/${definition.id}/activate`, {
        method: "POST",
        json: { expectedVersion: deactivated.version },
      }),
      { tenantId, definitionId: definition.id },
    );
    expect(activatedRes.status).toBe(200);
    assertMatchesOpenApi("activateCustomFieldDefinition", await readJson(activatedRes), [
      "definition",
    ]);

    const alreadyActive = await invoke(
      definitionActivate,
      request(`${base}/custom-fields/definitions/${definition.id}/activate`, {
        method: "POST",
        json: { expectedVersion: 4 },
      }),
      { tenantId, definitionId: definition.id },
    );
    expect(alreadyActive.status).toBe(422);

    const malformed = await invoke(
      definitionsGet,
      request(`${base}/custom-fields/definitions?limit=1&limit=2`),
      { tenantId },
    );
    expect(malformed.status).toBe(422);
    const unknownParam = await invoke(
      definitionsGet,
      request(`${base}/custom-fields/definitions?displayOrder=1`),
      { tenantId },
    );
    expect(unknownParam.status).toBe(422);
    const emptyCursor = await invoke(
      definitionsGet,
      request(`${base}/custom-fields/definitions?cursor=`),
      { tenantId },
    );
    expect(emptyCursor.status).toBe(422);

    const pageDefs: Definition[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await invoke(
        definitionsPost,
        request(`${base}/custom-fields/definitions`, {
          method: "POST",
          json: {
            entityType: "price_list",
            key: fieldKey(`p${i}`),
            label: `Page ${i}`,
            dataType: "STRING",
            displayOrder: i,
          },
        }),
        { tenantId },
      );
      expect(res.status).toBe(201);
      pageDefs.push(asDefinition(await readJson(res)));
    }
    const shuffled = await invoke(
      definitionPatch,
      request(`${base}/custom-fields/definitions/${pageDefs[0]!.id}`, {
        method: "PATCH",
        json: { expectedVersion: pageDefs[0]!.version, displayOrder: 99 },
      }),
      { tenantId, definitionId: pageDefs[0]!.id },
    );
    expect(shuffled.status).toBe(200);
    const expectedOrder = [...pageDefs].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const qs = new URLSearchParams({ limit: "1", entityType: "price_list" });
      if (cursor) qs.set("cursor", cursor);
      const page = await invoke(
        definitionsGet,
        request(`${base}/custom-fields/definitions?${qs.toString()}`),
        { tenantId },
      );
      expect(page.status).toBe(200);
      const body = (await readJson(page)).data as {
        definitions: Array<{ id: string }>;
        nextCursor: string | null;
      };
      for (const row of body.definitions) walked.push(row.id);
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(walked).toEqual(expectedOrder.map((row) => row.id));

    const defSchema = OPENAPI_DOC.components?.schemas
      ?.CustomFieldDefinition as OpenApiSchema;
    const brokenNull: OpenApiSchema = {
      ...defSchema,
      properties: {
        ...defSchema.properties,
        legalEntityId: { type: ["string", "null"], enum: ["not-null"] },
      },
    };
    expect(
      validateOpenApiValue(OPENAPI_DOC, brokenNull, definition, "broken-null").length,
    ).toBeGreaterThan(0);
    const brokenExtra: OpenApiSchema = { ...defSchema, additionalProperties: false };
    expect(
      validateOpenApiValue(
        OPENAPI_DOC,
        brokenExtra,
        { ...definition, tenantId: "leak" },
        "extra",
      ).length,
    ).toBeGreaterThan(0);
    const entitySchema = OPENAPI_DOC.components?.schemas
      ?.CustomFieldEntityType as OpenApiSchema;
    expect(
      validateOpenApiValue(
        OPENAPI_DOC,
        { ...entitySchema, enum: (entitySchema.enum ?? []).filter((v) => v !== "party") },
        "party",
        "missing-party",
      ).length,
    ).toBeGreaterThan(0);
    const dataSchema = OPENAPI_DOC.components?.schemas
      ?.CustomFieldDataType as OpenApiSchema;
    expect(
      validateOpenApiValue(
        OPENAPI_DOC,
        { ...dataSchema, enum: (dataSchema.enum ?? []).filter((v) => v !== "DECIMAL") },
        "DECIMAL",
        "missing-decimal",
      ).length,
    ).toBeGreaterThan(0);
    const typedSchema = OPENAPI_DOC.components?.schemas
      ?.CustomFieldTypedValue as OpenApiSchema;
    expect(
      validateOpenApiValue(
        OPENAPI_DOC,
        typedSchema,
        { dataType: "DECIMAL", value: 12.5 },
        "decimal-number",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      validateOpenApiValue(
        OPENAPI_DOC,
        typedSchema,
        { dataType: "STRING", value: 1 },
        "string-int",
      ).length,
    ).toBeGreaterThan(0);

    const audits = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) =>
        tx.auditEvent.findMany({ where: { tenantId }, orderBy: { sequence: "asc" } }),
    );
    expect(verifyAuditChain(toLinks(audits)).valid).toBe(true);
    const createdAudit = audits.find(
      (row) =>
        row.action === AUDIT_ACTIONS.CUSTOM_FIELD_DEFINITION_CREATED &&
        row.entityId === definition.id,
    );
    expect(createdAudit?.requestId).toBe(createRequestId);
    expect(createdAudit?.actorUserId).toBe(userId);
    expect(JSON.stringify(staleBody)).not.toMatch(/P2002|23505|sqlState/i);
  }, 180_000);

  it("serializes concurrent value upserts, deactivate-versus-set and advisory blocking through HTTP", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { setup, ctxAB, leA } = fixture;
    const tenantId = setup.tenantId;
    customFieldApiAuth.userId = setup.adminUserId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const party = await createTestParty(ctxAB, leA.id);
    const db = createSystemClient();

    const firstDefRes = await invoke(
      definitionsPost,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: {
          entityType: "party",
          key: fieldKey("race"),
          label: "Race",
          dataType: "STRING",
        },
      }),
      { tenantId },
    );
    const firstDef = asDefinition(await readJson(firstDefRes));
    const firstSettled = await Promise.allSettled([
      invoke(
        valuesPut,
        request(`${base}/custom-fields/values`, {
          method: "PUT",
          json: {
            definitionId: firstDef.id,
            entityId: party.party.id,
            value: { dataType: "STRING", value: "alpha" },
          },
        }),
        { tenantId },
      ),
      invoke(
        valuesPut,
        request(`${base}/custom-fields/values`, {
          method: "PUT",
          json: {
            definitionId: firstDef.id,
            entityId: party.party.id,
            value: { dataType: "STRING", value: "beta" },
          },
        }),
        { tenantId },
      ),
    ]);
    expect(firstSettled.every((row) => row.status === "fulfilled")).toBe(true);
    const firstResponses = firstSettled.map((row) =>
      row.status === "fulfilled" ? row.value : undefined,
    );
    for (const res of firstResponses) {
      expect(res?.status).toBe(200);
      expect(JSON.stringify(await readJson(res!))).not.toMatch(/23505|P2002|sqlState/i);
    }
    expect(
      await db.customFieldValue.count({
        where: { definitionId: firstDef.id, entityId: party.party.id },
      }),
    ).toBe(1);

    const overwriteSettled = await Promise.allSettled([
      invoke(
        valuesPut,
        request(`${base}/custom-fields/values`, {
          method: "PUT",
          json: {
            definitionId: firstDef.id,
            entityId: party.party.id,
            value: { dataType: "STRING", value: "one" },
          },
        }),
        { tenantId },
      ),
      invoke(
        valuesPut,
        request(`${base}/custom-fields/values`, {
          method: "PUT",
          json: {
            definitionId: firstDef.id,
            entityId: party.party.id,
            value: { dataType: "STRING", value: "two" },
          },
        }),
        { tenantId },
      ),
    ]);
    expect(overwriteSettled.every((row) => row.status === "fulfilled")).toBe(true);
    expect(
      await db.customFieldValue.count({
        where: { definitionId: firstDef.id, entityId: party.party.id },
      }),
    ).toBe(1);
    const canonical = await db.customFieldValue.findFirstOrThrow({
      where: { definitionId: firstDef.id, entityId: party.party.id },
    });
    expect(["one", "two"]).toContain(canonical.valueText);

    const setFirstDefRes = await invoke(
      definitionsPost,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: {
          entityType: "party",
          key: fieldKey("setf"),
          label: "Set first",
          dataType: "STRING",
        },
      }),
      { tenantId },
    );
    const setFirstDef = asDefinition(await readJson(setFirstDefRes));
    const setFirst = await invoke(
      valuesPut,
      request(`${base}/custom-fields/values`, {
        method: "PUT",
        json: {
          definitionId: setFirstDef.id,
          entityId: party.party.id,
          value: { dataType: "STRING", value: "first" },
        },
      }),
      { tenantId },
    );
    expect(setFirst.status).toBe(200);
    const afterSet = await invoke(
      definitionDeactivate,
      request(`${base}/custom-fields/definitions/${setFirstDef.id}/deactivate`, {
        method: "POST",
        json: { expectedVersion: 1 },
      }),
      { tenantId, definitionId: setFirstDef.id },
    );
    expect(afterSet.status).toBe(200);
    expect(
      await db.customFieldValue.count({
        where: { definitionId: setFirstDef.id, entityId: party.party.id },
      }),
    ).toBe(1);

    const deactivateFirstDefRes = await invoke(
      definitionsPost,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: {
          entityType: "party",
          key: fieldKey("deact"),
          label: "Deactivate first",
          dataType: "STRING",
        },
      }),
      { tenantId },
    );
    const deactivateFirstDef = asDefinition(await readJson(deactivateFirstDefRes));
    let blockedSet: Promise<Response> | undefined;
    await holdTx(
      ctxAB,
      async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          valueLockKey(tenantId, deactivateFirstDef.id, party.party.id),
        ]);
      },
      async () => {
        blockedSet = invoke(
          valuesPut,
          request(`${base}/custom-fields/values`, {
            method: "PUT",
            json: {
              definitionId: deactivateFirstDef.id,
              entityId: party.party.id,
              value: { dataType: "STRING", value: "late" },
            },
          }),
          { tenantId },
        );
        await waitUntilAdvisoryWaiters(1);
        const deactivated = await invoke(
          definitionDeactivate,
          request(
            `${base}/custom-fields/definitions/${deactivateFirstDef.id}/deactivate`,
            {
              method: "POST",
              json: { expectedVersion: 1 },
            },
          ),
          { tenantId, definitionId: deactivateFirstDef.id },
        );
        expect(deactivated.status).toBe(200);
        expect(
          await db.customFieldValue.count({
            where: { definitionId: deactivateFirstDef.id, entityId: party.party.id },
          }),
        ).toBe(0);
      },
    );
    const late = await blockedSet!;
    expect(late.status).toBe(409);
    expect(errorCode(await readJson(late))).toBe("CONFLICT");

    const advisoryDefRes = await invoke(
      definitionsPost,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: {
          entityType: "party",
          key: fieldKey("adv"),
          label: "Advisory",
          dataType: "STRING",
        },
      }),
      { tenantId },
    );
    const advisoryDef = asDefinition(await readJson(advisoryDefRes));
    const beforeAudits = await db.auditEvent.count({ where: { tenantId } });
    let releasedSet: Promise<Response> | undefined;
    await holdTx(
      ctxAB,
      async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          valueLockKey(tenantId, advisoryDef.id, party.party.id),
        ]);
      },
      async () => {
        releasedSet = invoke(
          valuesPut,
          request(`${base}/custom-fields/values`, {
            method: "PUT",
            json: {
              definitionId: advisoryDef.id,
              entityId: party.party.id,
              value: { dataType: "STRING", value: "held" },
            },
          }),
          { tenantId },
        );
        await waitUntilAdvisoryWaiters(1);
        const activity = await db.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*)::bigint AS n
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type IS NOT NULL`;
        expect(Number(activity[0]?.n ?? 0)).toBeGreaterThan(0);
        expect(
          await db.customFieldValue.count({
            where: { definitionId: advisoryDef.id, entityId: party.party.id },
          }),
        ).toBe(0);
        expect(await db.auditEvent.count({ where: { tenantId } })).toBe(beforeAudits);
      },
    );
    const afterHold = await releasedSet!;
    expect(afterHold.status).toBe(200);
    expect(
      await db.customFieldValue.count({
        where: { definitionId: advisoryDef.id, entityId: party.party.id },
      }),
    ).toBe(1);

    const audits = await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      (tx) =>
        tx.auditEvent.findMany({ where: { tenantId }, orderBy: { sequence: "asc" } }),
    );
    expect(verifyAuditChain(toLinks(audits)).valid).toBe(true);
  }, 180_000);
});

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
