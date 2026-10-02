import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { archiveParty, updateAssignment, updateCustomerRole } from "@noahark/crm";
import { archiveCatalogItemAssignment } from "@noahark/catalog";
import { POST as definitionsPost } from "@/app/api/v1/tenants/[tenantId]/custom-fields/definitions/route";
import { PUT as valuesPut } from "@/app/api/v1/tenants/[tenantId]/custom-fields/values/route";
import { GET as valueGet } from "@/app/api/v1/tenants/[tenantId]/custom-fields/values/[valueId]/route";
import {
  cleanupTenant,
  cleanupUser,
  createTestLegalEntity,
  grantLegalEntityAccessDirect,
  setupTestTenant,
  uniqueSlug,
} from "./testHelpers";
import {
  createAssignedCatalogGraph,
  createAssignedPartyGraph,
  fieldKey,
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

function opaqueShape(body: Record<string, unknown>) {
  const error = body.error as { code: string; message: string };
  return { code: error.code, hasMessage: typeof error.message === "string" };
}

describe("P2D.4 custom-field API targets", () => {
  let fixture: CustomFieldDomainFixture | undefined;
  let extraTenantId: string | undefined;
  let extraUserId: string | undefined;

  afterEach(async () => {
    customFieldApiAuth.userId = undefined;
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

  it("writes values for all nine target types and rejects archived, invisible and cross-tenant ids", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { setup, ctxAB, ctxA, leA, leB } = fixture;
    const tenantId = setup.tenantId;
    customFieldApiAuth.userId = setup.adminUserId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const parties = await createAssignedPartyGraph(ctxAB, leA.id, leB.id);
    const catalog = await createAssignedCatalogGraph(ctxAB, leA.id, leB.id);
    const targets: Array<{ entityType: string; entityId: string }> = [
      { entityType: "party", entityId: parties.party.id },
      { entityType: "party_contact", entityId: parties.contact.id },
      {
        entityType: "party_legal_entity_assignment",
        entityId: parties.ownerAssignment.id,
      },
      { entityType: "customer_role", entityId: parties.customerRole.id },
      { entityType: "vendor_role", entityId: parties.vendorRole.id },
      { entityType: "catalog_item", entityId: catalog.item.id },
      {
        entityType: "catalog_item_legal_entity_assignment",
        entityId: catalog.itemOwnerAssignment.id,
      },
      { entityType: "price_list", entityId: catalog.priceList.id },
      {
        entityType: "price_list_legal_entity_assignment",
        entityId: catalog.priceOwnerAssignment.id,
      },
    ];

    for (const target of targets) {
      const created = await invoke(
        definitionsPost,
        request(`${base}/custom-fields/definitions`, {
          method: "POST",
          json: {
            entityType: target.entityType,
            key: fieldKey(target.entityType.slice(0, 8)),
            label: target.entityType,
            dataType: "STRING",
          },
        }),
        { tenantId },
      );
      expect(created.status, target.entityType).toBe(201);
      const definitionId = (
        (await readJson(created)).data as { definition: { id: string } }
      ).definition.id;
      const written = await invoke(
        valuesPut,
        request(`${base}/custom-fields/values`, {
          method: "PUT",
          json: {
            definitionId,
            entityId: target.entityId,
            value: { dataType: "STRING", value: "ok" },
          },
        }),
        { tenantId },
      );
      expect(written.status, `${target.entityType} set`).toBe(200);
      const value = (
        (await readJson(written)).data as {
          value: { entityType: string; entityId: string; legalEntityId: string };
        }
      ).value;
      expect(value.entityType).toBe(target.entityType);
      expect(value.entityId).toBe(target.entityId);
      expect(value.legalEntityId).toBe(leA.id);
    }

    const partyDefRes = await invoke(
      definitionsPost,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: {
          entityType: "party",
          key: fieldKey("arch"),
          label: "Archived",
          dataType: "STRING",
        },
      }),
      { tenantId },
    );
    const partyDefId = (
      (await readJson(partyDefRes)).data as { definition: { id: string } }
    ).definition.id;
    const archived = await archiveParty(ctxA, parties.party.id, parties.party.version);
    expect(archived.status).toBe("ARCHIVED");
    const archivedSet = await invoke(
      valuesPut,
      request(`${base}/custom-fields/values`, {
        method: "PUT",
        json: {
          definitionId: partyDefId,
          entityId: parties.party.id,
          value: { dataType: "STRING", value: "nope" },
        },
      }),
      { tenantId },
    );
    expect(archivedSet.status).toBe(409);
    expect(errorCode(await readJson(archivedSet))).toBe("CONFLICT");

    const suspended = await updateAssignment(ctxAB, parties.assignmentB.id, {
      expectedVersion: parties.assignmentB.version,
      status: "SUSPENDED",
    });
    expect(suspended.status).toBe("SUSPENDED");
    const assignmentDef = await invoke(
      definitionsPost,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: {
          entityType: "party_legal_entity_assignment",
          key: fieldKey("susp"),
          label: "Suspended",
          dataType: "STRING",
        },
      }),
      { tenantId },
    );
    const assignmentDefId = (
      (await readJson(assignmentDef)).data as { definition: { id: string } }
    ).definition.id;
    const suspendedSet = await invoke(
      valuesPut,
      request(`${base}/custom-fields/values`, {
        method: "PUT",
        json: {
          definitionId: assignmentDefId,
          entityId: parties.assignmentB.id,
          value: { dataType: "STRING", value: "correction" },
        },
      }),
      { tenantId },
    );
    expect(suspendedSet.status).toBe(200);

    const suspendedRole = await updateCustomerRole(ctxAB, parties.customerRole.id, {
      expectedVersion: parties.customerRole.version,
      status: "SUSPENDED",
    });
    expect(suspendedRole.status).toBe("SUSPENDED");
    const roleDef = await invoke(
      definitionsPost,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: {
          entityType: "customer_role",
          key: fieldKey("role"),
          label: "Role",
          dataType: "STRING",
        },
      }),
      { tenantId },
    );
    const roleDefId = ((await readJson(roleDef)).data as { definition: { id: string } })
      .definition.id;
    const roleSet = await invoke(
      valuesPut,
      request(`${base}/custom-fields/values`, {
        method: "PUT",
        json: {
          definitionId: roleDefId,
          entityId: parties.customerRole.id,
          value: { dataType: "STRING", value: "ok" },
        },
      }),
      { tenantId },
    );
    expect(roleSet.status).toBe(200);

    const archivedAssignment = await archiveCatalogItemAssignment(
      ctxAB,
      catalog.itemOwnerAssignment.id,
      catalog.itemOwnerAssignment.version,
    );
    expect(archivedAssignment.status).toBe("ARCHIVED");
    const itemAssignDef = await invoke(
      definitionsPost,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: {
          entityType: "catalog_item_legal_entity_assignment",
          key: fieldKey("ia"),
          label: "Item assign",
          dataType: "STRING",
        },
      }),
      { tenantId },
    );
    const itemAssignDefId = (
      (await readJson(itemAssignDef)).data as { definition: { id: string } }
    ).definition.id;
    const archivedAssignSet = await invoke(
      valuesPut,
      request(`${base}/custom-fields/values`, {
        method: "PUT",
        json: {
          definitionId: itemAssignDefId,
          entityId: catalog.itemOwnerAssignment.id,
          value: { dataType: "STRING", value: "nope" },
        },
      }),
      { tenantId },
    );
    expect(archivedAssignSet.status).toBe(409);

    const invisible = await invoke(
      valuesPut,
      request(`${base}/custom-fields/values`, {
        method: "PUT",
        json: {
          definitionId: partyDefId,
          entityId: randomUUID(),
          value: { dataType: "STRING", value: "ghost" },
        },
      }),
      { tenantId },
    );
    expect(invisible.status).toBe(404);
    const missingGet = await invoke(
      valueGet,
      request(`${base}/custom-fields/values/${randomUUID()}`),
      { tenantId, valueId: randomUUID() },
    );
    expect(missingGet.status).toBe(404);
    expect(opaqueShape(await readJson(invisible))).toEqual(
      opaqueShape(await readJson(missingGet)),
    );

    const other = await setupTestTenant();
    extraTenantId = other.tenantId;
    extraUserId = other.adminUserId;
    const otherLe = await createTestLegalEntity(other.tenantId, "SG");
    await grantLegalEntityAccessDirect(other.tenantId, otherLe.id, other.adminUserId);
    customFieldApiAuth.userId = other.adminUserId;
    const cross = await invoke(
      valueGet,
      request(
        `https://noahark.example/api/v1/tenants/${other.tenantId}/custom-fields/values/${randomUUID()}`,
      ),
      { tenantId: other.tenantId, valueId: randomUUID() },
    );
    expect(cross.status).toBe(404);
    const crossBody = await readJson(cross);
    expect(errorCode(crossBody)).toBe("NOT_FOUND");
    expect(JSON.stringify(crossBody)).not.toMatch(/P2002|23505|sqlState|Prisma/i);
  }, 180_000);
});
