import { afterEach, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "@noahark/core";
import { createSystemClient } from "@noahark/db/system";
import {
  getCustomFieldDefinition,
  getCustomFieldValue,
  listCustomFieldValues,
  setCustomFieldValue,
} from "../../lib/services/customFieldDomain";
import {
  buildContext,
  cleanupTenant,
  cleanupUser,
  createTestLegalEntity,
  grantLegalEntityAccessDirect,
  setupTestTenant,
} from "./testHelpers";
import {
  createAssignedPartyGraph,
  createStringDefinition,
  createTestParty,
  fieldKey,
  setStringValue,
  setupCustomFieldDomainFixture,
  type CustomFieldDomainFixture,
} from "./customFieldDomainFixture";

describe("P2C.3 — custom-field isolation", () => {
  let fixture: CustomFieldDomainFixture | undefined;
  let extraTenantId: string | undefined;
  let extraUserId: string | undefined;

  afterEach(async () => {
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

  it("hides definitions and values from another tenant", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA, leA } = fixture;
    const party = await createTestParty(ctxA, leA.id);
    const definition = await createStringDefinition(ctxA, "party");
    const value = await setStringValue(ctxA, definition.id, party.party.id, "secret");

    const extra = await setupTestTenant();
    extraTenantId = extra.tenantId;
    extraUserId = extra.adminUserId;
    const extraLe = await createTestLegalEntity(extra.tenantId, "SG");
    await grantLegalEntityAccessDirect(extra.tenantId, extraLe.id, extra.adminUserId);
    const extraCtx = await buildContext(extra.adminUserId, extra.tenantId);
    expect(extraCtx.legalEntityIds.has(extraLe.id)).toBe(true);

    await expect(
      getCustomFieldDefinition(extraCtx, definition.id),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(getCustomFieldValue(extraCtx, value.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("does not let an assigned non-owner read or write the owner's shared-master value", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxAB, ctxA, ctxB, leA, leB } = fixture;
    const parties = await createAssignedPartyGraph(ctxAB, leA.id, leB.id);
    const definition = await createStringDefinition(ctxA, "party");
    const written = await setStringValue(
      ctxA,
      definition.id,
      parties.party.id,
      "owner-only",
    );

    await expect(
      setStringValue(ctxB, definition.id, parties.party.id, "hijack"),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getCustomFieldValue(ctxB, written.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const listed = await listCustomFieldValues(ctxB, {
      definitionId: definition.id,
      entityId: parties.party.id,
    });
    expect(listed.values).toHaveLength(0);

    const assignDef = await createStringDefinition(
      ctxAB,
      "party_legal_entity_assignment",
    );
    const assignedValue = await setStringValue(
      ctxB,
      assignDef.id,
      parties.assignmentB.id,
      "b-owns-this",
    );
    expect(assignedValue.legalEntityId).toBe(leB.id);
    await expect(getCustomFieldValue(ctxA, assignedValue.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("rejects empty legal-entity scope before opening a transaction", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxNone, ctxA, leA } = fixture;
    const party = await createTestParty(ctxA, leA.id);
    const definition = await createStringDefinition(ctxA, "party");
    await expect(
      setCustomFieldValue(ctxNone, {
        definitionId: definition.id,
        entityId: party.party.id,
        value: { dataType: "STRING", value: "x" },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getCustomFieldDefinition(ctxNone, definition.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("keeps a single unique (definitionId, entityId) row after contention", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA, leA } = fixture;
    const party = await createTestParty(ctxA, leA.id);
    const definition = await createStringDefinition(ctxA, "party", fieldKey("uniq"));
    const first = await setStringValue(ctxA, definition.id, party.party.id, "one");
    await setStringValue(ctxA, definition.id, party.party.id, "two");
    const db = createSystemClient();
    const count = await db.customFieldValue.count({
      where: { definitionId: definition.id, entityId: party.party.id },
    });
    expect(count).toBe(1);
    const row = await db.customFieldValue.findUnique({ where: { id: first.id } });
    expect(row?.valueText).toBe("two");
    expect(row?.version).toBe(2);
  });
});
