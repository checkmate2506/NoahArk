import { describe, expect, it } from "vitest";
import { Prisma } from "@noahark/db";
import { ConflictError, NotFoundError, ValidationError } from "@noahark/core";
import { mapCustomFieldDbError, pgErrorCode } from "./errors";
import {
  CreateCustomFieldDefinitionSchema,
  SetCustomFieldValueSchema,
  TypedValueEnvelopeSchema,
  UpdateCustomFieldDefinitionSchema,
} from "./schemas";

const AUTHORITY_KEYS = ["tenantId", "userId", "actorId", "permissions", "legalEntityIds"];

function schemaKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape);
}

describe("custom-field schemas", () => {
  it("omits legalEntityId and authority fields from create input", () => {
    const keys = schemaKeys(CreateCustomFieldDefinitionSchema);
    expect(keys).not.toContain("legalEntityId");
    for (const key of AUTHORITY_KEYS) {
      expect(keys).not.toContain(key);
    }
  });

  it("omits entityType, key and dataType from the update schema", () => {
    const keys = schemaKeys(UpdateCustomFieldDefinitionSchema);
    expect(keys).not.toContain("entityType");
    expect(keys).not.toContain("key");
    expect(keys).not.toContain("dataType");
    expect(keys).not.toContain("legalEntityId");
    expect(keys).toContain("expectedVersion");
  });

  it("rejects NUMBER, MULTI_SELECT and demo_approval_subject", () => {
    expect(() =>
      CreateCustomFieldDefinitionSchema.parse({
        entityType: "party",
        key: "k",
        label: "L",
        dataType: "NUMBER",
      }),
    ).toThrow();
    expect(() =>
      CreateCustomFieldDefinitionSchema.parse({
        entityType: "party",
        key: "k",
        label: "L",
        dataType: "MULTI_SELECT",
      }),
    ).toThrow();
    expect(() =>
      CreateCustomFieldDefinitionSchema.parse({
        entityType: "demo_approval_subject",
        key: "k",
        label: "L",
        dataType: "STRING",
      }),
    ).toThrow();
  });

  it("rejects untagged, mismatched and legacy JSON envelopes", () => {
    expect(() => TypedValueEnvelopeSchema.parse({ value: "x" })).toThrow();
    expect(() => TypedValueEnvelopeSchema.parse({ dataType: "STRING" })).toThrow();
    expect(() =>
      TypedValueEnvelopeSchema.parse({ dataType: "NUMBER", value: 1 }),
    ).toThrow();
    expect(() =>
      SetCustomFieldValueSchema.parse({
        definitionId: "d1",
        entityId: "e1",
        value: { hello: "world" },
      }),
    ).toThrow();
    expect(() =>
      SetCustomFieldValueSchema.parse({
        definitionId: "d1",
        entityId: "e1",
        legalEntityId: "le1",
        value: { dataType: "STRING", value: "x" },
      }),
    ).toThrow();
  });

  it("rejects 0/1 and string booleans", () => {
    expect(() =>
      TypedValueEnvelopeSchema.parse({ dataType: "BOOLEAN", value: 0 }),
    ).toThrow();
    expect(() =>
      TypedValueEnvelopeSchema.parse({ dataType: "BOOLEAN", value: 1 }),
    ).toThrow();
    expect(() =>
      TypedValueEnvelopeSchema.parse({ dataType: "BOOLEAN", value: "true" }),
    ).toThrow();
  });
});

describe("pgErrorCode and mapCustomFieldDbError", () => {
  it("walks nested originalCode without reading message text", () => {
    const error = {
      code: "P2039",
      message: "custom_field_value_phase2_typed_check violated",
      cause: {
        originalCode: "23514",
        code: "ERR",
        kind: "postgres",
      },
    };
    expect(pgErrorCode(error)).toBe("23514");
    expect(() => mapCustomFieldDbError(error, "Custom field value")).toThrow(
      ValidationError,
    );
    try {
      mapCustomFieldDbError(error, "Custom field value");
    } catch (mapped) {
      expect(mapped).toBeInstanceOf(ValidationError);
      expect((mapped as ValidationError).message).toBe(
        "Custom field value failed a storage constraint",
      );
      expect((mapped as ValidationError).message).not.toMatch(/_check/);
      expect((mapped as ValidationError).message).not.toMatch(/23514/);
      expect((mapped as ValidationError).message).not.toMatch(/prisma/i);
    }
  });

  it("maps 42501 to NOT_FOUND and 23505/P2002 to CONFLICT", () => {
    expect(() => mapCustomFieldDbError({ code: "42501" }, "Target")).toThrow(
      NotFoundError,
    );
    expect(() => mapCustomFieldDbError({ originalCode: "23505" }, "X")).toThrow(
      ConflictError,
    );
    const p2002 = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
    });
    expect(() => mapCustomFieldDbError(p2002, "Custom field definition")).toThrow(
      ConflictError,
    );
  });

  it("maps P2025 to NOT_FOUND and P2003/23503 to VALIDATION_FAILED", () => {
    const p2025 = new Prisma.PrismaClientKnownRequestError("missing", {
      code: "P2025",
      clientVersion: "test",
    });
    expect(() => mapCustomFieldDbError(p2025, "Custom field value")).toThrow(
      NotFoundError,
    );
    const p2003 = new Prisma.PrismaClientKnownRequestError("fk", {
      code: "P2003",
      clientVersion: "test",
    });
    expect(() => mapCustomFieldDbError(p2003, "Custom field value")).toThrow(
      ValidationError,
    );
    expect(() => mapCustomFieldDbError({ code: "23503" }, "Custom field value")).toThrow(
      ValidationError,
    );
  });

  it("rethrows unknown infrastructure errors", () => {
    const boom = new Error("connection reset");
    expect(() => mapCustomFieldDbError(boom, "Custom field value")).toThrow(boom);
  });

  it("is cycle-guarded", () => {
    const cyclic: { cause?: unknown; code: string } = { code: "X" };
    cyclic.cause = cyclic;
    expect(pgErrorCode(cyclic)).toBeUndefined();
  });
});
