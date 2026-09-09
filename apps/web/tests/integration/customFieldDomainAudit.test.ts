import { afterEach, describe, expect, it } from "vitest";
import { verifyAuditChain, type AuditChainLink } from "@noahark/audit";
import { ConflictError } from "@noahark/core";
import { withTenantContext } from "@noahark/db";
import {
  createCustomFieldDefinition,
  setCustomFieldValue,
} from "../../lib/services/customFieldDomain";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  createTestParty,
  fieldKey,
  setStringValue,
  setupCustomFieldDomainFixture,
  type CustomFieldDomainFixture,
} from "./customFieldDomainFixture";

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

function assertNoValueContent(payload: unknown) {
  const text = JSON.stringify(payload);
  expect(text).not.toMatch(/hello-secret/);
  expect(text).not.toMatch(/"valueText"/);
  expect(text).not.toMatch(/"valueInteger"/);
  expect(text).not.toMatch(/"valueDecimal"/);
  expect(text).not.toMatch(/"valueBoolean"/);
  expect(text).not.toMatch(/"valueDate"/);
  expect(text).not.toMatch(/"valueOption"/);
}

describe("P2C.3 — custom-field audit", () => {
  let fixture: CustomFieldDomainFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("records identifiers and versions without custom-field values", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA, leA } = fixture;
    const party = await createTestParty(ctxA, leA.id);
    const definition = await createCustomFieldDefinition(ctxA, {
      entityType: "party",
      key: fieldKey("aud"),
      label: "Audit",
      dataType: "STRING",
    });
    const created = await setStringValue(
      ctxA,
      definition.id,
      party.party.id,
      "hello-secret",
    );
    await setCustomFieldValue(ctxA, {
      definitionId: definition.id,
      entityId: party.party.id,
      value: { dataType: "STRING", value: "hello-secret-2" },
    });

    const events = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) =>
        tx.auditEvent.findMany({
          where: { tenantId: ctxA.tenantId },
          orderBy: { sequence: "asc" },
        }),
    );
    const actions = events.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "custom_field_definition.created",
        "custom_field_value.created",
        "custom_field_value.updated",
      ]),
    );
    const valueEvents = events.filter((e) => e.entityType === "custom_field_value");
    expect(valueEvents.length).toBeGreaterThanOrEqual(2);
    for (const event of valueEvents) {
      expect(event.legalEntityId).toBe(leA.id);
      assertNoValueContent(event.beforeData);
      assertNoValueContent(event.afterData);
    }
    const definitionEvents = events.filter(
      (e) => e.entityType === "custom_field_definition",
    );
    for (const event of definitionEvents) {
      expect(event.legalEntityId).toBeNull();
      assertNoValueContent(event.afterData);
    }
    expect(created.typedValue.value).toBe("hello-secret");
    const result = verifyAuditChain(toLinks(events));
    expect(result.valid).toBe(true);
  });

  it("rolls back the mutation and its audit event together", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA } = fixture;
    const key = fieldKey("dup");
    await createCustomFieldDefinition(ctxA, {
      entityType: "party",
      key,
      label: "First",
      dataType: "STRING",
    });
    const before = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) => tx.auditEvent.count({ where: { tenantId: ctxA.tenantId } }),
    );
    await expect(
      createCustomFieldDefinition(ctxA, {
        entityType: "party",
        key,
        label: "Second",
        dataType: "STRING",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    const after = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) => tx.auditEvent.count({ where: { tenantId: ctxA.tenantId } }),
    );
    expect(after).toBe(before);
    const definitions = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) =>
        tx.customFieldDefinition.count({
          where: { tenantId: ctxA.tenantId, key },
        }),
    );
    expect(definitions).toBe(1);
  });
});
