import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { PERMISSIONS } from "@noahark/authz";
import { createSystemClient } from "@noahark/db/system";
import { withTenantContext } from "@noahark/db";
import {
  API_WRITE_MAX_PER_TENANT_USER,
  API_WRITE_TENANT,
  API_WRITE_TENANT_USER,
  apiWriteCanonicalKey,
  consumeApiWriteAllowance,
  hashKey,
} from "@/lib/rateLimiter";
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
  createStringDefinition,
  createTestParty,
  setStringValue,
  setupCustomFieldDomainFixture,
  type CustomFieldDomainFixture,
} from "./customFieldDomainFixture";

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

describe("P2D.4 custom-field API permissions", () => {
  let fixture: CustomFieldDomainFixture | undefined;
  const extraUsers: string[] = [];
  let extraTenantId: string | undefined;
  let extraUserId: string | undefined;

  afterEach(async () => {
    customFieldApiAuth.userId = undefined;
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
    if (extraTenantId) {
      await cleanupTenant(extraTenantId).catch(() => undefined);
      extraTenantId = undefined;
    }
    if (extraUserId) {
      await cleanupUser(extraUserId).catch(() => undefined);
      extraUserId = undefined;
    }
  });

  it("covers the nine-operation tenant-wide permission matrix, forged authority, CSRF and rate buckets", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { setup, ctxAB, leA, leB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const party = await createTestParty(ctxAB, leA.id);
    const definition = await createStringDefinition(ctxAB, "party");
    const patchDef = await createStringDefinition(ctxAB, "party");
    const deactivateDef = await createStringDefinition(ctxAB, "party");
    const inactive = await createStringDefinition(ctxAB, "party");
    await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => {
        await tx.customFieldDefinition.update({
          where: { id: inactive.id },
          data: { isActive: false, version: { increment: 1 } },
        });
      },
    );
    const value = await setStringValue(ctxAB, definition.id, party.party.id, "seed");

    const snapshot = () =>
      withTenantContext(
        { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
        async (tx) => ({
          definitions: await tx.customFieldDefinition.count({ where: { tenantId } }),
          values: await tx.customFieldValue.count({ where: { tenantId } }),
          audits: await tx.auditEvent.count({
            where: {
              tenantId,
              action: {
                in: [
                  "custom_field_definition.created",
                  "custom_field_definition.updated",
                  "custom_field_definition.deactivated",
                  "custom_field_definition.activated",
                  "custom_field_value.created",
                  "custom_field_value.updated",
                ],
              },
            },
          }),
        }),
      );

    type Op = {
      name: string;
      permission: string;
      neighbor: string;
      write: boolean;
      run: () => {
        handler: LooseHandler;
        req: Request;
        params: { tenantId: string } & Record<string, string>;
      };
    };

    const ops: Op[] = [
      {
        name: "GET /custom-fields/definitions",
        permission: PERMISSIONS.CUSTOM_FIELD_DEFINITION_READ,
        neighbor: PERMISSIONS.CUSTOM_FIELD_DEFINITION_CREATE,
        write: false,
        run: () => ({
          handler: definitionsGet as unknown as LooseHandler,
          req: request(`${base}/custom-fields/definitions`),
          params: { tenantId },
        }),
      },
      {
        name: "POST /custom-fields/definitions",
        permission: PERMISSIONS.CUSTOM_FIELD_DEFINITION_CREATE,
        neighbor: PERMISSIONS.CUSTOM_FIELD_DEFINITION_READ,
        write: true,
        run: () => ({
          handler: definitionsPost as unknown as LooseHandler,
          req: request(`${base}/custom-fields/definitions`, {
            method: "POST",
            json: {
              entityType: "party",
              key: uniqueSlug("k").slice(0, 16),
              label: "X",
              dataType: "STRING",
            },
          }),
          params: { tenantId },
        }),
      },
      {
        name: "GET /custom-fields/definitions/{id}",
        permission: PERMISSIONS.CUSTOM_FIELD_DEFINITION_READ,
        neighbor: PERMISSIONS.CUSTOM_FIELD_VALUE_READ,
        write: false,
        run: () => ({
          handler: definitionGet as unknown as LooseHandler,
          req: request(`${base}/custom-fields/definitions/${definition.id}`),
          params: { tenantId, definitionId: definition.id },
        }),
      },
      {
        name: "PATCH /custom-fields/definitions/{id}",
        permission: PERMISSIONS.CUSTOM_FIELD_DEFINITION_UPDATE,
        neighbor: PERMISSIONS.CUSTOM_FIELD_DEFINITION_SET_STATUS,
        write: true,
        run: () => ({
          handler: definitionPatch as unknown as LooseHandler,
          req: request(`${base}/custom-fields/definitions/${patchDef.id}`, {
            method: "PATCH",
            json: {
              expectedVersion: patchDef.version,
              label: "No",
            },
          }),
          params: { tenantId, definitionId: patchDef.id },
        }),
      },
      {
        name: "POST /custom-fields/definitions/{id}/deactivate",
        permission: PERMISSIONS.CUSTOM_FIELD_DEFINITION_SET_STATUS,
        neighbor: PERMISSIONS.CUSTOM_FIELD_DEFINITION_UPDATE,
        write: true,
        run: () => ({
          handler: definitionDeactivate as unknown as LooseHandler,
          req: request(
            `${base}/custom-fields/definitions/${deactivateDef.id}/deactivate`,
            {
              method: "POST",
              json: { expectedVersion: deactivateDef.version },
            },
          ),
          params: { tenantId, definitionId: deactivateDef.id },
        }),
      },
      {
        name: "POST /custom-fields/definitions/{id}/activate",
        permission: PERMISSIONS.CUSTOM_FIELD_DEFINITION_SET_STATUS,
        neighbor: PERMISSIONS.CUSTOM_FIELD_DEFINITION_CREATE,
        write: true,
        run: () => ({
          handler: definitionActivate as unknown as LooseHandler,
          req: request(`${base}/custom-fields/definitions/${inactive.id}/activate`, {
            method: "POST",
            json: { expectedVersion: 2 },
          }),
          params: { tenantId, definitionId: inactive.id },
        }),
      },
      {
        name: "GET /custom-fields/values",
        permission: PERMISSIONS.CUSTOM_FIELD_VALUE_READ,
        neighbor: PERMISSIONS.CUSTOM_FIELD_VALUE_WRITE,
        write: false,
        run: () => ({
          handler: valuesGet as unknown as LooseHandler,
          req: request(`${base}/custom-fields/values`),
          params: { tenantId },
        }),
      },
      {
        name: "GET /custom-fields/values/{id}",
        permission: PERMISSIONS.CUSTOM_FIELD_VALUE_READ,
        neighbor: PERMISSIONS.CUSTOM_FIELD_DEFINITION_READ,
        write: false,
        run: () => ({
          handler: valueGet as unknown as LooseHandler,
          req: request(`${base}/custom-fields/values/${value.id}`),
          params: { tenantId, valueId: value.id },
        }),
      },
      {
        name: "PUT /custom-fields/values",
        permission: PERMISSIONS.CUSTOM_FIELD_VALUE_WRITE,
        neighbor: PERMISSIONS.CUSTOM_FIELD_VALUE_READ,
        write: true,
        run: () => ({
          handler: valuesPut as unknown as LooseHandler,
          req: request(`${base}/custom-fields/values`, {
            method: "PUT",
            json: {
              definitionId: definition.id,
              entityId: party.party.id,
              value: { dataType: "STRING", value: "hijack" },
            },
          }),
          params: { tenantId },
        }),
      },
    ];

    for (const op of ops) {
      const none = await createActor(
        tenantId,
        setup.adminUserId,
        [],
        [leA.id, leB.id],
        null,
      );
      extraUsers.push(none.id);
      const neighbor = await createActor(
        tenantId,
        setup.adminUserId,
        [op.neighbor],
        [leA.id, leB.id],
        null,
      );
      extraUsers.push(neighbor.id);
      const scoped = await createActor(
        tenantId,
        setup.adminUserId,
        [op.permission],
        [leA.id, leB.id],
        leB.id,
      );
      extraUsers.push(scoped.id);

      const deniedCall = op.run();
      const before = await snapshot();
      const beforeBuckets = await writeBucketCounts(tenantId, none.id);
      customFieldApiAuth.userId = none.id;
      expect(
        (await invokeLoose(deniedCall.handler, deniedCall.req.clone(), deniedCall.params))
          .status,
        `${op.name} absent`,
      ).toBe(403);
      customFieldApiAuth.userId = neighbor.id;
      expect(
        (await invokeLoose(deniedCall.handler, deniedCall.req.clone(), deniedCall.params))
          .status,
        `${op.name} neighbor`,
      ).toBe(403);
      customFieldApiAuth.userId = scoped.id;
      expect(
        (await invokeLoose(deniedCall.handler, deniedCall.req.clone(), deniedCall.params))
          .status,
        `${op.name} entity-scoped`,
      ).toBe(403);
      expect(await snapshot(), `${op.name} snapshot`).toEqual(before);
      if (op.write) {
        expect(await writeBucketCounts(tenantId, none.id)).toEqual(beforeBuckets);
      }

      const exact = await createActor(
        tenantId,
        setup.adminUserId,
        [op.permission],
        [leA.id, leB.id],
        null,
      );
      extraUsers.push(exact.id);
      customFieldApiAuth.userId = exact.id;
      const successCall = op.run();
      const success = await invokeLoose(
        successCall.handler,
        successCall.req,
        successCall.params,
      );
      expect(success.status, `${op.name} exact`).toBeLessThan(400);
    }

    customFieldApiAuth.userId = setup.adminUserId;
    const beforeWrite = await writeBucketCounts(tenantId, setup.adminUserId);
    const authorizedWrite = await invokeLoose(
      definitionsPost as unknown as LooseHandler,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: {
          entityType: "party",
          key: uniqueSlug("ok").slice(0, 16),
          label: "Ok",
          dataType: "STRING",
        },
      }),
      { tenantId },
    );
    expect(authorizedWrite.status).toBe(201);
    expect(await writeBucketCounts(tenantId, setup.adminUserId)).toEqual({
      user: beforeWrite.user + 1,
      tenant: beforeWrite.tenant + 1,
    });
    const forgedBody = {
      entityType: "party",
      key: uniqueSlug("fg").slice(0, 16),
      label: "Forged",
      dataType: "STRING",
      permissions: [PERMISSIONS.CUSTOM_FIELD_DEFINITION_CREATE],
      permissionKeys: [PERMISSIONS.CUSTOM_FIELD_DEFINITION_CREATE],
      actingUserId: setup.adminUserId,
      requestId: "forged",
      tenantId,
      legalEntityIds: [leA.id],
    };
    const noneActor = await createActor(tenantId, setup.adminUserId, [], [leA.id], null);
    extraUsers.push(noneActor.id);
    customFieldApiAuth.userId = noneActor.id;
    const forgedNone = await invokeLoose(
      definitionsPost as unknown as LooseHandler,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: forgedBody,
      }),
      { tenantId },
    );
    expect(forgedNone.status).toBe(403);
    customFieldApiAuth.userId = setup.adminUserId;
    const forgedAdmin = await invokeLoose(
      definitionsPost as unknown as LooseHandler,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: forgedBody,
      }),
      { tenantId },
    );
    expect(forgedAdmin.status).toBe(422);
    const afterWrite = await writeBucketCounts(tenantId, setup.adminUserId);
    const authorizedGet = await invokeLoose(
      definitionsGet as unknown as LooseHandler,
      request(`${base}/custom-fields/definitions`),
      { tenantId },
    );
    expect(authorizedGet.status).toBe(200);
    expect(await writeBucketCounts(tenantId, setup.adminUserId)).toEqual(afterWrite);

    const csrfBefore = await snapshot();
    const csrfBuckets = await writeBucketCounts(tenantId, setup.adminUserId);
    const evil = { Origin: "https://evil.example" };
    const csrfDef = await invokeLoose(
      definitionsPost as unknown as LooseHandler,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        headers: evil,
        json: {
          entityType: "party",
          key: uniqueSlug("csrf").slice(0, 16),
          label: "Csrf",
          dataType: "STRING",
        },
      }),
      { tenantId },
    );
    const csrfValue = await invokeLoose(
      valuesPut as unknown as LooseHandler,
      request(`${base}/custom-fields/values`, {
        method: "PUT",
        headers: evil,
        json: {
          definitionId: definition.id,
          entityId: party.party.id,
          value: { dataType: "STRING", value: "csrf" },
        },
      }),
      { tenantId },
    );
    expect(csrfDef.status).toBe(403);
    expect(csrfValue.status).toBe(403);
    expect(await snapshot()).toEqual(csrfBefore);
    expect(await writeBucketCounts(tenantId, setup.adminUserId)).toEqual(csrfBuckets);

    const other = await setupTestTenant();
    extraTenantId = other.tenantId;
    extraUserId = other.adminUserId;
    const otherLe = await createTestLegalEntity(other.tenantId, "SG");
    await grantLegalEntityAccessDirect(other.tenantId, otherLe.id, other.adminUserId);
    customFieldApiAuth.userId = setup.adminUserId;
    const forgedTenant = await invokeLoose(
      definitionsGet as unknown as LooseHandler,
      request(
        `https://noahark.example/api/v1/tenants/${other.tenantId}/custom-fields/definitions`,
      ),
      { tenantId: other.tenantId },
    );
    expect(forgedTenant.status).toBe(403);

    customFieldApiAuth.userId = other.adminUserId;
    const cross = await invokeLoose(
      definitionGet as unknown as LooseHandler,
      request(
        `https://noahark.example/api/v1/tenants/${other.tenantId}/custom-fields/definitions/${definition.id}`,
      ),
      { tenantId: other.tenantId, definitionId: definition.id },
    );
    const missing = await invokeLoose(
      definitionGet as unknown as LooseHandler,
      request(
        `https://noahark.example/api/v1/tenants/${other.tenantId}/custom-fields/definitions/does-not-exist`,
      ),
      { tenantId: other.tenantId, definitionId: "does-not-exist" },
    );
    expect(cross.status).toBe(404);
    expect(missing.status).toBe(404);
    const crossBody = await readJson(cross);
    const missingBody = await readJson(missing);
    expect((crossBody.error as { code: string }).code).toBe("NOT_FOUND");
    expect((missingBody.error as { code: string }).code).toBe("NOT_FOUND");
    expect(JSON.stringify(crossBody)).not.toMatch(/P2002|23505|sqlState|Prisma/i);

    const emptyScope = await createActor(
      tenantId,
      setup.adminUserId,
      [PERMISSIONS.CUSTOM_FIELD_DEFINITION_READ, PERMISSIONS.CUSTOM_FIELD_VALUE_WRITE],
      [],
      null,
    );
    extraUsers.push(emptyScope.id);
    customFieldApiAuth.userId = emptyScope.id;
    expect(
      (
        await invokeLoose(
          definitionsGet as unknown as LooseHandler,
          request(`${base}/custom-fields/definitions`),
          { tenantId },
        )
      ).status,
    ).toBe(403);

    customFieldApiAuth.userId = setup.adminUserId;
    const limitedBefore = await snapshot();
    for (let i = 0; i < API_WRITE_MAX_PER_TENANT_USER + 5; i++) {
      const result = await consumeApiWriteAllowance({
        tenantId,
        userId: setup.adminUserId,
      });
      if (result !== "ok") break;
    }
    const limited = await invokeLoose(
      definitionsPost as unknown as LooseHandler,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: {
          entityType: "party",
          key: uniqueSlug("lim").slice(0, 16),
          label: "Limited",
          dataType: "STRING",
        },
      }),
      { tenantId },
    );
    expect(limited.status).toBe(429);
    expect(((await readJson(limited)).error as { code: string }).code).toBe(
      "RATE_LIMITED",
    );
    expect(await snapshot()).toEqual(limitedBefore);
  }, 240_000);
});
