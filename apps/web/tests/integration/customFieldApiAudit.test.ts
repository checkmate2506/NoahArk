import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { AUDIT_ACTIONS, verifyAuditChain } from "@noahark/audit";
import { withTenantContext } from "@noahark/db";
import { POST as definitionsPost } from "@/app/api/v1/tenants/[tenantId]/custom-fields/definitions/route";
import { PATCH as definitionPatch } from "@/app/api/v1/tenants/[tenantId]/custom-fields/definitions/[definitionId]/route";
import { POST as definitionDeactivate } from "@/app/api/v1/tenants/[tenantId]/custom-fields/definitions/[definitionId]/deactivate/route";
import { POST as definitionActivate } from "@/app/api/v1/tenants/[tenantId]/custom-fields/definitions/[definitionId]/activate/route";
import { PUT as valuesPut } from "@/app/api/v1/tenants/[tenantId]/custom-fields/values/route";
import { cleanupTenant, cleanupUser, uniqueSlug } from "./testHelpers";
import {
  createTestParty,
  fieldKey,
  setupCustomFieldDomainFixture,
  type CustomFieldDomainFixture,
} from "./customFieldDomainFixture";

const SECRET = "cf-secret-never-log";

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
    requestId: string | null;
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

describe("P2D.4 custom-field API audit", () => {
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

  it("records the six mutation actions with trusted identity and no value secrecy leaks", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { setup, ctxAB, leA } = fixture;
    const tenantId = setup.tenantId;
    const userId = setup.adminUserId;
    customFieldApiAuth.userId = userId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const party = await createTestParty(ctxAB, leA.id);
    const key = fieldKey("aud");
    const createRid = uniqueSlug("rid");
    const updateRid = uniqueSlug("rid");
    const deactRid = uniqueSlug("rid");
    const actRid = uniqueSlug("rid");
    const valueCreateRid = uniqueSlug("rid");
    const valueUpdateRid = uniqueSlug("rid");

    const createdRes = await invoke(
      definitionsPost,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        headers: { "x-request-id": createRid },
        json: {
          entityType: "party",
          key,
          label: "Audit",
          dataType: "STRING",
        },
      }),
      { tenantId },
    );
    expect(createdRes.status).toBe(201);
    const definition = (
      (await readJson(createdRes)).data as {
        definition: { id: string; version: number };
      }
    ).definition;

    const auditsAfterCreate = await listAudits(tenantId, ctxAB.legalEntityIds);
    const duplicate = await invoke(
      definitionsPost,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: { entityType: "party", key, label: "Dup", dataType: "STRING" },
      }),
      { tenantId },
    );
    expect(duplicate.status).toBe(409);
    expect((await listAudits(tenantId, ctxAB.legalEntityIds)).length).toBe(
      auditsAfterCreate.length,
    );

    const updatedRes = await invoke(
      definitionPatch,
      request(`${base}/custom-fields/definitions/${definition.id}`, {
        method: "PATCH",
        headers: { "x-request-id": updateRid },
        json: {
          expectedVersion: definition.version,
          label: "Audit renamed",
        },
      }),
      { tenantId, definitionId: definition.id },
    );
    expect(updatedRes.status).toBe(200);

    const stale = await invoke(
      definitionPatch,
      request(`${base}/custom-fields/definitions/${definition.id}`, {
        method: "PATCH",
        json: { expectedVersion: 1, label: "Stale" },
      }),
      { tenantId, definitionId: definition.id },
    );
    expect(stale.status).toBe(409);
    const afterStale = await listAudits(tenantId, ctxAB.legalEntityIds);

    const malformed = await invoke(
      definitionPatch,
      request(`${base}/custom-fields/definitions/${definition.id}`, {
        method: "PATCH",
        json: { expectedVersion: 2, entityType: "catalog_item" },
      }),
      { tenantId, definitionId: definition.id },
    );
    expect(malformed.status).toBe(422);
    expect((await listAudits(tenantId, ctxAB.legalEntityIds)).length).toBe(
      afterStale.length,
    );

    const setRes = await invoke(
      valuesPut,
      request(`${base}/custom-fields/values`, {
        method: "PUT",
        headers: { "x-request-id": valueCreateRid },
        json: {
          definitionId: definition.id,
          entityId: party.party.id,
          value: { dataType: "STRING", value: SECRET },
        },
      }),
      { tenantId },
    );
    expect(setRes.status).toBe(200);

    const overwrite = await invoke(
      valuesPut,
      request(`${base}/custom-fields/values`, {
        method: "PUT",
        headers: { "x-request-id": valueUpdateRid },
        json: {
          definitionId: definition.id,
          entityId: party.party.id,
          value: { dataType: "STRING", value: `${SECRET}-2` },
        },
      }),
      { tenantId },
    );
    expect(overwrite.status).toBe(200);

    const deactivated = await invoke(
      definitionDeactivate,
      request(`${base}/custom-fields/definitions/${definition.id}/deactivate`, {
        method: "POST",
        headers: { "x-request-id": deactRid },
        json: { expectedVersion: 2 },
      }),
      { tenantId, definitionId: definition.id },
    );
    expect(deactivated.status).toBe(200);

    const inactiveSet = await invoke(
      valuesPut,
      request(`${base}/custom-fields/values`, {
        method: "PUT",
        json: {
          definitionId: definition.id,
          entityId: party.party.id,
          value: { dataType: "STRING", value: SECRET },
        },
      }),
      { tenantId },
    );
    expect(inactiveSet.status).toBe(409);
    const afterInactive = await listAudits(tenantId, ctxAB.legalEntityIds);

    const alreadyInactive = await invoke(
      definitionDeactivate,
      request(`${base}/custom-fields/definitions/${definition.id}/deactivate`, {
        method: "POST",
        json: { expectedVersion: 3 },
      }),
      { tenantId, definitionId: definition.id },
    );
    expect(alreadyInactive.status).toBe(422);
    expect((await listAudits(tenantId, ctxAB.legalEntityIds)).length).toBe(
      afterInactive.length,
    );

    const activated = await invoke(
      definitionActivate,
      request(`${base}/custom-fields/definitions/${definition.id}/activate`, {
        method: "POST",
        headers: { "x-request-id": actRid },
        json: { expectedVersion: 3 },
      }),
      { tenantId, definitionId: definition.id },
    );
    expect(activated.status).toBe(200);

    const invisible = await invoke(
      valuesPut,
      request(`${base}/custom-fields/values`, {
        method: "PUT",
        json: {
          definitionId: definition.id,
          entityId: "does-not-exist",
          value: { dataType: "STRING", value: SECRET },
        },
      }),
      { tenantId },
    );
    expect(invisible.status).toBe(404);

    const csrf = await invoke(
      valuesPut,
      request(`${base}/custom-fields/values`, {
        method: "PUT",
        headers: { Origin: "https://evil.example" },
        json: {
          definitionId: definition.id,
          entityId: party.party.id,
          value: { dataType: "STRING", value: SECRET },
        },
      }),
      { tenantId },
    );
    expect(csrf.status).toBe(403);

    const audits = await listAudits(tenantId, ctxAB.legalEntityIds);
    expect(verifyAuditChain(toLinks(audits)).valid).toBe(true);
    const byAction = (action: string) =>
      audits.filter((row) => row.action === action && row.entityId === definition.id);
    const valueAudits = audits.filter(
      (row) =>
        row.action === AUDIT_ACTIONS.CUSTOM_FIELD_VALUE_CREATED ||
        row.action === AUDIT_ACTIONS.CUSTOM_FIELD_VALUE_UPDATED,
    );
    expect(byAction(AUDIT_ACTIONS.CUSTOM_FIELD_DEFINITION_CREATED)).toHaveLength(1);
    expect(byAction(AUDIT_ACTIONS.CUSTOM_FIELD_DEFINITION_UPDATED)).toHaveLength(1);
    expect(byAction(AUDIT_ACTIONS.CUSTOM_FIELD_DEFINITION_DEACTIVATED)).toHaveLength(1);
    expect(byAction(AUDIT_ACTIONS.CUSTOM_FIELD_DEFINITION_ACTIVATED)).toHaveLength(1);
    expect(
      audits.filter((row) => row.action === AUDIT_ACTIONS.CUSTOM_FIELD_VALUE_CREATED),
    ).toHaveLength(1);
    expect(
      audits.filter((row) => row.action === AUDIT_ACTIONS.CUSTOM_FIELD_VALUE_UPDATED),
    ).toHaveLength(1);

    const createdAudit = byAction(AUDIT_ACTIONS.CUSTOM_FIELD_DEFINITION_CREATED)[0];
    expect(createdAudit?.actorUserId).toBe(userId);
    expect(createdAudit?.requestId).toBe(createRid);
    expect(
      audits.find((row) => row.action === AUDIT_ACTIONS.CUSTOM_FIELD_DEFINITION_UPDATED)
        ?.requestId,
    ).toBe(updateRid);
    expect(
      audits.find(
        (row) => row.action === AUDIT_ACTIONS.CUSTOM_FIELD_DEFINITION_DEACTIVATED,
      )?.requestId,
    ).toBe(deactRid);
    expect(
      audits.find((row) => row.action === AUDIT_ACTIONS.CUSTOM_FIELD_DEFINITION_ACTIVATED)
        ?.requestId,
    ).toBe(actRid);
    expect(
      audits.find((row) => row.action === AUDIT_ACTIONS.CUSTOM_FIELD_VALUE_CREATED)
        ?.requestId,
    ).toBe(valueCreateRid);
    expect(
      audits.find((row) => row.action === AUDIT_ACTIONS.CUSTOM_FIELD_VALUE_UPDATED)
        ?.requestId,
    ).toBe(valueUpdateRid);

    const payload = JSON.stringify(
      audits.map((row) => ({
        action: row.action,
        beforeData: row.beforeData,
        afterData: row.afterData,
        requestId: row.requestId,
        actorUserId: row.actorUserId,
      })),
    );
    expect(payload).not.toContain(SECRET);
    expect(payload).not.toMatch(/valueText|valueInteger|valueDecimal|typedValue/);
    expect(payload).not.toMatch(/P2002|23505|sqlState|Prisma/);
    expect(JSON.stringify(await readJson(invisible))).not.toContain(SECRET);
    expect(valueAudits.every((row) => row.actorUserId === userId)).toBe(true);
  }, 120_000);
});

async function listAudits(tenantId: string, legalEntityIds: ReadonlySet<string>) {
  return withTenantContext({ tenantId, legalEntityIds }, (tx) =>
    tx.auditEvent.findMany({
      where: { tenantId },
      orderBy: { sequence: "asc" },
    }),
  );
}
