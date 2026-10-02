import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { withTenantContext } from "@noahark/db";
import { GET as definitionGet } from "@/app/api/v1/tenants/[tenantId]/custom-fields/definitions/[definitionId]/route";
import {
  GET as valuesGet,
  PUT as valuesPut,
} from "@/app/api/v1/tenants/[tenantId]/custom-fields/values/route";
import { GET as valueGet } from "@/app/api/v1/tenants/[tenantId]/custom-fields/values/[valueId]/route";
import { POST as partyTransfer } from "@/app/api/v1/tenants/[tenantId]/parties/[partyId]/ownership-transfer/route";
import {
  addTenantMember,
  assignRoleDirect,
  cleanupTenant,
  cleanupUser,
  createTestUser,
  grantLegalEntityAccessDirect,
  uniqueSlug,
} from "./testHelpers";
import { createSystemClient } from "@noahark/db/system";
import { PERMISSIONS } from "@noahark/authz";
import {
  createAssignedCatalogGraph,
  createAssignedPartyGraph,
  createStringDefinition,
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
      const actor = req.headers.get("x-test-actor") ?? customFieldApiAuth.userId;
      if (!actor) throw new UnauthenticatedError();
      return actual.getAccessContext(actor, tenantId, actual.requestMeta(req, requestId));
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

function opaqueShape(body: Record<string, unknown>) {
  const error = body.error as { code: string; message: string };
  return { code: error.code, hasMessage: typeof error.message === "string" };
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

describe("P2D.4 custom-field owner boundary", () => {
  let fixture: CustomFieldDomainFixture | undefined;
  const extraUsers: string[] = [];

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
  });

  it("enforces D-10 owner write/read versus assigned non-owner on shared masters", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { setup, ctxAB, leA, leB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const parties = await createAssignedPartyGraph(ctxAB, leA.id, leB.id);
    const catalog = await createAssignedCatalogGraph(ctxAB, leA.id, leB.id);
    const keys = [
      PERMISSIONS.CUSTOM_FIELD_VALUE_READ,
      PERMISSIONS.CUSTOM_FIELD_VALUE_WRITE,
      PERMISSIONS.CUSTOM_FIELD_DEFINITION_READ,
      PERMISSIONS.PARTY_TRANSFER_OWNERSHIP,
    ];
    const owner = await createActor(tenantId, setup.adminUserId, keys, [leA.id]);
    const assigned = await createActor(tenantId, setup.adminUserId, keys, [leB.id]);
    extraUsers.push(owner.id, assigned.id);

    const masters: Array<{ entityType: string; entityId: string; version?: number }> = [
      { entityType: "party", entityId: parties.party.id, version: parties.party.version },
      { entityType: "catalog_item", entityId: catalog.item.id },
      { entityType: "price_list", entityId: catalog.priceList.id },
    ];

    for (const master of masters) {
      const definition = await createStringDefinition(ctxAB, master.entityType);
      customFieldApiAuth.userId = owner.id;
      const written = await invokeLoose(
        valuesPut as unknown as LooseHandler,
        request(`${base}/custom-fields/values`, {
          method: "PUT",
          json: {
            definitionId: definition.id,
            entityId: master.entityId,
            value: { dataType: "STRING", value: "owner-only" },
          },
        }),
        { tenantId },
      );
      expect(written.status, master.entityType).toBe(200);
      const value = ((await readJson(written)).data as { value: { id: string } }).value;

      customFieldApiAuth.userId = assigned.id;
      const hijack = await invokeLoose(
        valuesPut as unknown as LooseHandler,
        request(`${base}/custom-fields/values`, {
          method: "PUT",
          json: {
            definitionId: definition.id,
            entityId: master.entityId,
            value: { dataType: "STRING", value: "hijack" },
          },
        }),
        { tenantId },
      );
      expect(hijack.status, `${master.entityType} write`).toBe(403);
      const hiddenGet = await invokeLoose(
        valueGet as unknown as LooseHandler,
        request(`${base}/custom-fields/values/${value.id}`),
        { tenantId, valueId: value.id },
      );
      expect(hiddenGet.status, `${master.entityType} get`).toBe(404);
      const listed = await invokeLoose(
        valuesGet as unknown as LooseHandler,
        request(
          `${base}/custom-fields/values?definitionId=${definition.id}&entityId=${master.entityId}`,
        ),
        { tenantId },
      );
      expect(listed.status).toBe(200);
      expect(
        ((await readJson(listed)).data as { values: unknown[] }).values,
      ).toHaveLength(0);

      customFieldApiAuth.userId = owner.id;
      const visible = await invokeLoose(
        valueGet as unknown as LooseHandler,
        request(`${base}/custom-fields/values/${value.id}`),
        { tenantId, valueId: value.id },
      );
      expect(visible.status).toBe(200);
    }

    const partyDef = await createStringDefinition(ctxAB, "party");
    customFieldApiAuth.userId = owner.id;
    const ownerValueRes = await invokeLoose(
      valuesPut as unknown as LooseHandler,
      request(`${base}/custom-fields/values`, {
        method: "PUT",
        json: {
          definitionId: partyDef.id,
          entityId: parties.party.id,
          value: { dataType: "STRING", value: "before-transfer" },
        },
      }),
      { tenantId },
    );
    const ownerValue = ((await readJson(ownerValueRes)).data as { value: { id: string } })
      .value;
    customFieldApiAuth.userId = setup.adminUserId;
    const transferred = await invokeLoose(
      partyTransfer as unknown as LooseHandler,
      request(`${base}/parties/${parties.party.id}/ownership-transfer`, {
        method: "POST",
        json: { newOwnerLegalEntityId: leB.id, expectedVersion: parties.party.version },
      }),
      { tenantId, partyId: parties.party.id },
    );
    expect(transferred.status).toBe(200);

    customFieldApiAuth.userId = owner.id;
    const afterOwner = await invokeLoose(
      valueGet as unknown as LooseHandler,
      request(`${base}/custom-fields/values/${ownerValue.id}`),
      { tenantId, valueId: ownerValue.id },
    );
    customFieldApiAuth.userId = assigned.id;
    const afterAssigned = await invokeLoose(
      valueGet as unknown as LooseHandler,
      request(`${base}/custom-fields/values/${ownerValue.id}`),
      { tenantId, valueId: ownerValue.id },
    );
    const missing = await invokeLoose(
      valueGet as unknown as LooseHandler,
      request(`${base}/custom-fields/values/does-not-exist`),
      { tenantId, valueId: "does-not-exist" },
    );
    expect(missing.status).toBe(404);
    const missingBody = await readJson(missing);
    const afterOwnerBody = await readJson(afterOwner);
    const afterAssignedBody = await readJson(afterAssigned);
    if (afterOwner.status === 404) {
      expect(opaqueShape(afterOwnerBody)).toEqual(opaqueShape(missingBody));
    } else {
      expect(afterOwner.status).toBe(200);
    }
    if (afterAssigned.status === 404) {
      expect(opaqueShape(afterAssignedBody)).toEqual(opaqueShape(missingBody));
    } else {
      expect(afterAssigned.status).toBe(200);
    }

    customFieldApiAuth.userId = assigned.id;
    const hiddenDef = await invokeLoose(
      definitionGet as unknown as LooseHandler,
      request(`${base}/custom-fields/definitions/${partyDef.id}`),
      { tenantId, definitionId: partyDef.id },
    );
    expect(hiddenDef.status).toBe(200);

    expect(JSON.stringify(missingBody)).not.toMatch(
      /P2002|23505|sqlState|Prisma|owner-only|before-transfer/i,
    );
    if (afterOwner.status === 404) {
      expect(JSON.stringify(afterOwnerBody)).not.toMatch(
        /P2002|23505|sqlState|Prisma|owner-only|before-transfer/i,
      );
    }

    await withTenantContext(
      { tenantId, legalEntityIds: new Set(ctxAB.legalEntityIds) },
      async (tx) => {
        const row = await tx.customFieldValue.findFirst({
          where: { id: ownerValue.id },
        });
        expect(row).toBeTruthy();
      },
    );
  }, 120_000);
});
