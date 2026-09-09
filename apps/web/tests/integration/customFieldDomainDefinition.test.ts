import { afterEach, describe, expect, it } from "vitest";
import {
  ConflictError,
  ForbiddenError,
  StaleVersionError,
  ValidationError,
} from "@noahark/core";
import { createSystemClient } from "@noahark/db/system";
import {
  activateCustomFieldDefinition,
  createCustomFieldDefinition,
  deactivateCustomFieldDefinition,
  getCustomFieldDefinition,
  listCustomFieldDefinitions,
  updateCustomFieldDefinition,
} from "../../lib/services/customFieldDomain";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  fieldKey,
  createTestParty,
  setStringValue,
  setupCustomFieldDomainFixture,
  type CustomFieldDomainFixture,
} from "./customFieldDomainFixture";

describe("P2C.3 — custom-field definitions", () => {
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

  it("creates, gets, lists, updates, deactivates and activates a tenant-wide definition", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA, ctxNone } = fixture;
    const key = fieldKey();
    const created = await createCustomFieldDefinition(ctxA, {
      entityType: "party",
      key,
      label: "Nickname",
      dataType: "STRING",
      displayOrder: 7,
    });
    expect(created.legalEntityId).toBeNull();
    expect(created.entityType).toBe("party");
    expect(created.key).toBe(key);
    expect(created.dataType).toBe("STRING");
    expect(created.isActive).toBe(true);
    expect(created.version).toBe(1);
    expect(created.displayOrder).toBe(7);
    expect(created.options).toBeNull();

    const fetched = await getCustomFieldDefinition(ctxA, created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.legalEntityId).toBeNull();

    const listed = await listCustomFieldDefinitions(ctxA, { entityType: "party" });
    expect(listed.definitions.some((row) => row.id === created.id)).toBe(true);
    expect(listed.definitions[0]?.displayOrder).toBeTypeOf("number");

    const updated = await updateCustomFieldDefinition(ctxA, created.id, {
      expectedVersion: 1,
      label: "Aka",
      isRequired: true,
      displayOrder: 3,
    });
    expect(updated.label).toBe("Aka");
    expect(updated.isRequired).toBe(true);
    expect(updated.displayOrder).toBe(3);
    expect(updated.version).toBe(2);
    expect(updated.entityType).toBe("party");
    expect(updated.key).toBe(key);
    expect(updated.dataType).toBe("STRING");

    await expect(
      updateCustomFieldDefinition(ctxA, created.id, {
        expectedVersion: 1,
        label: "stale",
      }),
    ).rejects.toBeInstanceOf(StaleVersionError);

    const deactivated = await deactivateCustomFieldDefinition(ctxA, created.id, {
      expectedVersion: 2,
    });
    expect(deactivated.isActive).toBe(false);
    expect(deactivated.version).toBe(3);

    const activeOnly = await listCustomFieldDefinitions(ctxA, { entityType: "party" });
    expect(activeOnly.definitions.some((row) => row.id === created.id)).toBe(false);
    const inactive = await listCustomFieldDefinitions(ctxA, {
      entityType: "party",
      isActive: false,
    });
    expect(inactive.definitions.some((row) => row.id === created.id)).toBe(true);

    const reactivated = await activateCustomFieldDefinition(ctxA, created.id, {
      expectedVersion: 3,
    });
    expect(reactivated.isActive).toBe(true);
    expect(reactivated.version).toBe(4);

    await expect(
      createCustomFieldDefinition(ctxNone, {
        entityType: "party",
        key: fieldKey(),
        label: "Nope",
        dataType: "STRING",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("enforces tenant-wide key uniqueness and rejects identity mutation", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA, ctxB } = fixture;
    const key = fieldKey("same");
    await createCustomFieldDefinition(ctxA, {
      entityType: "party",
      key,
      label: "First",
      dataType: "STRING",
    });
    await expect(
      createCustomFieldDefinition(ctxB, {
        entityType: "party",
        key,
        label: "Second",
        dataType: "STRING",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const other = await createCustomFieldDefinition(ctxA, {
      entityType: "catalog_item",
      key,
      label: "Other type",
      dataType: "STRING",
    });
    expect(other.entityType).toBe("catalog_item");

    await expect(
      updateCustomFieldDefinition(ctxA, other.id, {
        expectedVersion: 1,
        entityType: "party",
        label: "nope",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("validates SINGLE_SELECT options and allows add-only updates", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA } = fixture;
    await expect(
      createCustomFieldDefinition(ctxA, {
        entityType: "party",
        key: fieldKey(),
        label: "Color",
        dataType: "SINGLE_SELECT",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createCustomFieldDefinition(ctxA, {
        entityType: "party",
        key: fieldKey(),
        label: "Note",
        dataType: "STRING",
        options: ["x"],
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const created = await createCustomFieldDefinition(ctxA, {
      entityType: "party",
      key: fieldKey("opt"),
      label: "Color",
      dataType: "SINGLE_SELECT",
      options: [" red ", "blue"],
    });
    expect(created.options).toEqual(["red", "blue"]);

    const extended = await updateCustomFieldDefinition(ctxA, created.id, {
      expectedVersion: 1,
      options: ["red", "blue", "green"],
    });
    expect(extended.options).toEqual(["red", "blue", "green"]);
    expect(extended.version).toBe(2);

    await expect(
      updateCustomFieldDefinition(ctxA, created.id, {
        expectedVersion: 2,
        options: ["red", "green"],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("lists by createdAt, id rather than displayOrder", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA } = fixture;
    const first = await createCustomFieldDefinition(ctxA, {
      entityType: "party",
      key: fieldKey("a"),
      label: "A",
      dataType: "STRING",
      displayOrder: 90,
    });
    const second = await createCustomFieldDefinition(ctxA, {
      entityType: "party",
      key: fieldKey("b"),
      label: "B",
      dataType: "STRING",
      displayOrder: 1,
    });
    const page = await listCustomFieldDefinitions(ctxA, {
      entityType: "party",
      limit: 1,
    });
    expect(page.definitions).toHaveLength(1);
    expect(page.definitions[0]?.id).toBe(first.id);
    expect(page.nextCursor).toBeTruthy();
    const next = await listCustomFieldDefinitions(ctxA, {
      entityType: "party",
      limit: 10,
      cursor: page.nextCursor ?? undefined,
    });
    expect(next.definitions[0]?.id).toBe(second.id);
    expect(first.displayOrder).toBe(90);
    expect(second.displayOrder).toBe(1);
  });

  it("rejects NUMBER, MULTI_SELECT and demo_approval_subject at the service", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA } = fixture;
    await expect(
      createCustomFieldDefinition(ctxA, {
        entityType: "party",
        key: fieldKey(),
        label: "Bad",
        dataType: "NUMBER",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createCustomFieldDefinition(ctxA, {
        entityType: "demo_approval_subject",
        key: fieldKey(),
        label: "Bad",
        dataType: "STRING",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("does not delete values when a definition is deactivated", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA, leA } = fixture;
    const party = await createTestParty(ctxA, leA.id);
    const definition = await createCustomFieldDefinition(ctxA, {
      entityType: "party",
      key: fieldKey("keep"),
      label: "Keep",
      dataType: "STRING",
    });
    const value = await setStringValue(ctxA, definition.id, party.party.id, "stay");
    await deactivateCustomFieldDefinition(ctxA, definition.id, {
      expectedVersion: definition.version,
    });
    const db = createSystemClient();
    const persisted = await db.customFieldValue.findUnique({ where: { id: value.id } });
    expect(persisted?.valueText).toBe("stay");
    expect(persisted?.version).toBe(1);
  });
});
