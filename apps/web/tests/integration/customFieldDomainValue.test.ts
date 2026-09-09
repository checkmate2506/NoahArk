import { afterEach, describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@noahark/core";
import { createSystemClient } from "@noahark/db/system";
import {
  createCustomFieldDefinition,
  deactivateCustomFieldDefinition,
  getCustomFieldValue,
  listCustomFieldValues,
  setCustomFieldValue,
} from "../../lib/services/customFieldDomain";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  createStringDefinition,
  createTestParty,
  fieldKey,
  setStringValue,
  setupCustomFieldDomainFixture,
  type CustomFieldDomainFixture,
} from "./customFieldDomainFixture";

describe("P2C.3 — typed custom-field values", () => {
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

  it("round-trips every supported tagged type and stores exactly one typed column", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA, leA } = fixture;
    const party = await createTestParty(ctxA, leA.id);
    const cases: Array<{
      dataType: "STRING" | "INTEGER" | "DECIMAL" | "BOOLEAN" | "DATE" | "SINGLE_SELECT";
      options?: string[];
      input: unknown;
      expected: unknown;
      column: string;
    }> = [
      {
        dataType: "STRING",
        input: { dataType: "STRING", value: "  hello  " },
        expected: { dataType: "STRING", value: "hello" },
        column: "valueText",
      },
      {
        dataType: "INTEGER",
        input: { dataType: "INTEGER", value: 42 },
        expected: { dataType: "INTEGER", value: 42 },
        column: "valueInteger",
      },
      {
        dataType: "DECIMAL",
        input: { dataType: "DECIMAL", value: "-12.5" },
        expected: { dataType: "DECIMAL", value: "-12.500000" },
        column: "valueDecimal",
      },
      {
        dataType: "BOOLEAN",
        input: { dataType: "BOOLEAN", value: false },
        expected: { dataType: "BOOLEAN", value: false },
        column: "valueBoolean",
      },
      {
        dataType: "DATE",
        input: { dataType: "DATE", value: "2026-07-01" },
        expected: { dataType: "DATE", value: "2026-07-01" },
        column: "valueDate",
      },
      {
        dataType: "SINGLE_SELECT",
        options: ["red", "blue"],
        input: { dataType: "SINGLE_SELECT", value: "red" },
        expected: { dataType: "SINGLE_SELECT", value: "red" },
        column: "valueOption",
      },
    ];

    const db = createSystemClient();
    for (const row of cases) {
      const definition = await createCustomFieldDefinition(ctxA, {
        entityType: "party",
        key: fieldKey(row.dataType.toLowerCase()),
        label: row.dataType,
        dataType: row.dataType,
        ...(row.options ? { options: row.options } : {}),
      });
      const written = await setCustomFieldValue(ctxA, {
        definitionId: definition.id,
        entityId: party.party.id,
        value: row.input,
      });
      expect(written.typedValue).toEqual(row.expected);
      expect(written.legalEntityId).toBe(leA.id);
      const fetched = await getCustomFieldValue(ctxA, written.id);
      expect(fetched.typedValue).toEqual(row.expected);
      const stored = await db.customFieldValue.findUnique({ where: { id: written.id } });
      expect(stored).toBeTruthy();
      expect(stored?.value).toBeNull();
      expect(stored?.valueText ?? null).toBe(row.column === "valueText" ? "hello" : null);
      expect(stored?.valueInteger ?? null).toBe(
        row.column === "valueInteger" ? 42 : null,
      );
      expect(stored?.valueBoolean ?? null).toBe(
        row.column === "valueBoolean" ? false : null,
      );
      expect(stored?.valueOption ?? null).toBe(
        row.column === "valueOption" ? "red" : null,
      );
      if (row.column === "valueDecimal") {
        expect(stored?.valueDecimal?.toFixed(6)).toBe("-12.500000");
      } else {
        expect(stored?.valueDecimal).toBeNull();
      }
      if (row.column === "valueDate") {
        expect(stored?.valueDate?.toISOString().slice(0, 10)).toBe("2026-07-01");
      } else {
        expect(stored?.valueDate).toBeNull();
      }
    }
  });

  it("overwrites an existing value and keeps a single unique row", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA, leA } = fixture;
    const party = await createTestParty(ctxA, leA.id);
    const definition = await createStringDefinition(ctxA, "party");
    const first = await setStringValue(ctxA, definition.id, party.party.id, "one");
    const second = await setStringValue(ctxA, definition.id, party.party.id, "two");
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(2);
    expect(second.typedValue).toEqual({ dataType: "STRING", value: "two" });
    const listed = await listCustomFieldValues(ctxA, {
      definitionId: definition.id,
      entityId: party.party.id,
    });
    expect(listed.values).toHaveLength(1);
  });

  it("rejects inactive definitions, type mismatch and untagged input", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA, leA } = fixture;
    const party = await createTestParty(ctxA, leA.id);
    const definition = await createStringDefinition(ctxA, "party");
    await deactivateCustomFieldDefinition(ctxA, definition.id, {
      expectedVersion: 1,
    });
    await expect(
      setStringValue(ctxA, definition.id, party.party.id, "nope"),
    ).rejects.toBeInstanceOf(ConflictError);

    const active = await createStringDefinition(ctxA, "party");
    await expect(
      setCustomFieldValue(ctxA, {
        definitionId: active.id,
        entityId: party.party.id,
        value: { dataType: "INTEGER", value: 1 },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      setCustomFieldValue(ctxA, {
        definitionId: active.id,
        entityId: party.party.id,
        value: { hello: "world" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
