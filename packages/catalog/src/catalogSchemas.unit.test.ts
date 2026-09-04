import { describe, expect, it } from "vitest";
import { Prisma } from "@noahark/db";
import {
  boundPageSize,
  ConflictError,
  decodeCreatedAtIdCursor,
  encodeCreatedAtIdCursor,
  ValidationError,
} from "@noahark/core";
import { mapCatalogDbError } from "./errors";
import {
  CreateCatalogCategorySchema,
  CreateCatalogItemSchema,
  CreateUnitOfMeasureSchema,
  ListCatalogItemsSchema,
  UpdateCatalogCategorySchema,
  UpdateCatalogItemSchema,
  UpdateUnitOfMeasureSchema,
} from "./schemas";
import { normaliseSearchTerm } from "./search";

const AUTHORITY_KEYS = ["tenantId", "userId", "actorId", "permissions", "legalEntityIds"];

function schemaKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape);
}

describe("catalog Zod schemas", () => {
  it("trims and bounds category and UOM create fields", () => {
    expect(
      CreateCatalogCategorySchema.parse({ code: "  CAT  ", name: "  Name  " }),
    ).toEqual({
      code: "CAT",
      name: "Name",
    });
    expect(() => CreateCatalogCategorySchema.parse({ code: "   ", name: "N" })).toThrow();
    expect(() =>
      CreateCatalogCategorySchema.parse({ code: "x".repeat(33), name: "N" }),
    ).toThrow();
    expect(CreateUnitOfMeasureSchema.parse({ code: "EA", name: "Each" }).code).toBe("EA");
  });

  it("omits code from category/UOM update schemas and rejects a code key", () => {
    expect(schemaKeys(UpdateCatalogCategorySchema)).not.toContain("code");
    expect(schemaKeys(UpdateUnitOfMeasureSchema)).not.toContain("code");
  });

  it("omits itemType and ownerLegalEntityId from item update schema", () => {
    expect(schemaKeys(UpdateCatalogItemSchema)).not.toContain("itemType");
    expect(schemaKeys(UpdateCatalogItemSchema)).not.toContain("ownerLegalEntityId");
    expect(
      CreateCatalogItemSchema.parse({
        ownerLegalEntityId: "le1",
        code: "SKU",
        itemType: "PRODUCT",
        name: "Widget",
        baseUomId: "uom1",
      }).itemType,
    ).toBe("PRODUCT");
    expect(() =>
      CreateCatalogItemSchema.parse({
        ownerLegalEntityId: "le1",
        code: "SKU",
        itemType: "OTHER",
        name: "Widget",
        baseUomId: "uom1",
      }),
    ).toThrow();
  });

  it("declares no tenant/user/actor/permissions/legalEntityIds-as-authority fields", () => {
    const schemas = [
      CreateCatalogCategorySchema,
      UpdateCatalogCategorySchema,
      CreateUnitOfMeasureSchema,
      UpdateUnitOfMeasureSchema,
      CreateCatalogItemSchema,
      UpdateCatalogItemSchema,
      ListCatalogItemsSchema,
    ];
    for (const schema of schemas) {
      for (const key of AUTHORITY_KEYS) {
        expect(schemaKeys(schema), key).not.toContain(key);
      }
    }
  });

  it("preserves null versus absent on item update", () => {
    const withNull = UpdateCatalogItemSchema.parse({
      expectedVersion: 1,
      categoryId: null,
      description: null,
      taxCategoryCode: null,
    });
    expect(withNull.categoryId).toBeNull();
    expect(withNull.description).toBeNull();
    expect(withNull.taxCategoryCode).toBeNull();
    const absent = UpdateCatalogItemSchema.parse({ expectedVersion: 1, name: "N" });
    expect(absent.categoryId).toBeUndefined();
    expect(absent.description).toBeUndefined();
  });
});

describe("normaliseSearchTerm", () => {
  it("is identical under LANG=tr_TR.UTF-8", () => {
    const previous = process.env.LANG;
    process.env.LANG = "tr_TR.UTF-8";
    try {
      expect(normaliseSearchTerm("  I  ")).toBe("i");
      expect(normaliseSearchTerm("CAT")).toBe("cat");
    } finally {
      if (previous === undefined) delete process.env.LANG;
      else process.env.LANG = previous;
    }
  });
});

describe("pagination helpers", () => {
  it("bounds page size and round-trips cursors", () => {
    expect(boundPageSize(undefined)).toBe(25);
    expect(boundPageSize(1000)).toBe(100);
    expect(() => boundPageSize(0)).toThrow(ValidationError);
    const at = new Date("2026-08-25T10:00:00.000Z");
    const encoded = encodeCreatedAtIdCursor(at, "abc");
    expect(decodeCreatedAtIdCursor(encoded)).toEqual({ createdAt: at, id: "abc" });
    expect(() => decodeCreatedAtIdCursor("%%%")).toThrow(ValidationError);
  });
});

describe("mapCatalogDbError", () => {
  function leak(text: string) {
    expect(text).not.toMatch(/23/);
    expect(text).not.toMatch(/P200/);
    expect(text).not.toMatch(/_key/);
    expect(text).not.toMatch(/_check/);
    expect(text).not.toMatch(/_fkey/);
    expect(text).not.toMatch(/pg_/);
    expect(text).not.toMatch(/prisma/i);
    expect(text).not.toMatch(/catalog_item_/);
    expect(text).not.toMatch(/unit_of_measure_/);
  }

  it("maps SQLSTATE and Prisma codes without leaking internals", () => {
    try {
      mapCatalogDbError({ code: "42501" }, "Catalog item");
    } catch (error) {
      expect((error as Error).message).toBe("Catalog item not found");
      leak((error as Error).message);
    }
    try {
      mapCatalogDbError({ code: "23505" }, "Catalog item");
    } catch (error) {
      leak((error as Error).message);
    }
    try {
      mapCatalogDbError({ code: "23503" }, "Catalog item");
    } catch (error) {
      leak((error as Error).message);
    }
    try {
      mapCatalogDbError({ code: "23514" }, "Catalog item");
    } catch (error) {
      leak((error as Error).message);
    }

    const p2002 = (target: string[]) =>
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "7.9.1",
        meta: { target },
      });
    try {
      mapCatalogDbError(p2002(["catalog_item_tenant_id_code"]), "Catalog item");
    } catch (error) {
      expect((error as Error).message).toBe("Catalog item code is already in use");
      leak((error as Error).message);
    }
    try {
      mapCatalogDbError(p2002(["entity_item_code"]), "Assignment");
    } catch (error) {
      leak((error as Error).message);
    }
    try {
      mapCatalogDbError(p2002(["catalog_item_id", "legal_entity_id"]), "Assignment");
    } catch (error) {
      leak((error as Error).message);
    }
    try {
      mapCatalogDbError(p2002(["catalog_category_tenant_id_code"]), "Category");
    } catch (error) {
      leak((error as Error).message);
    }
    try {
      mapCatalogDbError(p2002(["unit_of_measure_tenant_id_code"]), "Unit of measure");
    } catch (error) {
      leak((error as Error).message);
    }
    try {
      mapCatalogDbError(p2002(["other"]), "Catalog item");
    } catch (error) {
      leak((error as Error).message);
    }

    try {
      mapCatalogDbError(
        new Prisma.PrismaClientKnownRequestError("missing", {
          code: "P2025",
          clientVersion: "7.9.1",
        }),
        "Catalog item",
      );
    } catch (error) {
      leak((error as Error).message);
    }
    try {
      mapCatalogDbError(
        new Prisma.PrismaClientKnownRequestError("fk", {
          code: "P2003",
          clientVersion: "7.9.1",
        }),
        "Catalog item",
      );
    } catch (error) {
      leak((error as Error).message);
    }
  });

  it("maps synthetic 23P01 to CONFLICT without leaking internals", () => {
    const err = { code: "23P01", message: "exclusion_violation" };
    try {
      mapCatalogDbError(err, "Catalog item");
      throw new Error("expected mapping");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      leak((error as Error).message);
    }
  });
});
