import { describe, expect, it } from "vitest";
import { Prisma } from "@noahark/db";
import { ValidationError } from "@noahark/core";
import { formatCivilDate, parseCivilDate } from "./civilDate";
import { formatDecimal, parseDecimalString } from "./pricingDecimal";
import { normaliseSearchTerm } from "./search";
import {
  ClosePriceListEntrySchema,
  CreatePriceListEntrySchema,
  CreatePriceListSchema,
  decodeEffectiveFromIdCursor,
  encodeEffectiveFromIdCursor,
  ListPriceListEntriesSchema,
  ResolveEffectivePriceSchema,
  SetDefaultPriceListSchema,
  UpdatePriceListEntrySchema,
  UpdatePriceListSchema,
} from "./pricingSchemas";

const AUTHORITY_KEYS = ["tenantId", "userId", "actorId", "permissions", "legalEntityIds"];

function schemaKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape);
}

describe("parseDecimalString", () => {
  it("accepts canonical NUMERIC(23,6) strings", () => {
    expect(parseDecimalString("0")).toBe("0");
    expect(parseDecimalString("0.000001")).toBe("0.000001");
    expect(parseDecimalString("1")).toBe("1");
    expect(parseDecimalString("12.5")).toBe("12.5");
    expect(parseDecimalString("99999999999999999.999999")).toBe(
      "99999999999999999.999999",
    );
  });

  it("rejects non-canonical strings", () => {
    const rejected = [
      "",
      " ",
      "-1",
      "-0",
      "+1",
      "1e5",
      "1E5",
      "0x10",
      "1.0000001",
      "999999999999999999",
      "1,5",
      "Infinity",
      "NaN",
      ".5",
      "5.",
    ];
    for (const raw of rejected) {
      expect(() => parseDecimalString(raw), raw).toThrow(ValidationError);
    }
  });
});

describe("formatDecimal", () => {
  it("always yields 6 decimals", () => {
    expect(formatDecimal(new Prisma.Decimal("0"))).toBe("0.000000");
    expect(formatDecimal(new Prisma.Decimal("0.000001"))).toBe("0.000001");
    expect(formatDecimal(new Prisma.Decimal("12.5"))).toBe("12.500000");
    expect(formatDecimal(new Prisma.Decimal("99999999999999999.999999"))).toBe(
      "99999999999999999.999999",
    );
  });
});

describe("civil dates", () => {
  it("accepts real calendar days", () => {
    expect(formatCivilDate(parseCivilDate("2026-07-01"))).toBe("2026-07-01");
    expect(formatCivilDate(parseCivilDate("2024-02-29"))).toBe("2024-02-29");
  });

  it("rejects malformed or non-calendar days", () => {
    const rejected = [
      "2026-7-1",
      "2026-02-30",
      "2027-02-29",
      "2026-13-01",
      "20260701",
      "2026-07-01T00:00:00Z",
      "",
    ];
    for (const raw of rejected) {
      expect(() => parseCivilDate(raw), raw).toThrow(ValidationError);
    }
  });

  it("round-trips under Asia/Jakarta, Pacific/Kiritimati and Etc/GMT+12", () => {
    const previous = process.env.TZ;
    const zones = ["Asia/Jakarta", "Pacific/Kiritimati", "Etc/GMT+12"];
    try {
      for (const zone of zones) {
        process.env.TZ = zone;
        expect(formatCivilDate(parseCivilDate("2026-07-01"))).toBe("2026-07-01");
        expect(formatCivilDate(parseCivilDate("2024-02-29"))).toBe("2024-02-29");
      }
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});

describe("pricing Zod schemas", () => {
  it("omits immutable keys from update schemas", () => {
    expect(schemaKeys(UpdatePriceListSchema)).not.toContain("currency");
    expect(schemaKeys(UpdatePriceListSchema)).not.toContain("ownerLegalEntityId");
    expect(schemaKeys(UpdatePriceListEntrySchema)).not.toContain("priceListAssignmentId");
    expect(schemaKeys(UpdatePriceListEntrySchema)).not.toContain(
      "catalogItemAssignmentId",
    );
    expect(schemaKeys(UpdatePriceListEntrySchema)).not.toContain("legalEntityId");
    expect(schemaKeys(UpdatePriceListEntrySchema)).not.toContain("tenantId");
  });

  it("setDefaultPriceList schema has exactly legalEntityId and priceListId", () => {
    expect(schemaKeys(SetDefaultPriceListSchema).sort()).toEqual(
      ["legalEntityId", "priceListId"].sort(),
    );
    expect(schemaKeys(SetDefaultPriceListSchema)).not.toContain("expectedVersion");
  });

  it("declares no tenant/user/actor/permissions/legalEntityIds-as-authority fields", () => {
    const schemas = [
      CreatePriceListSchema,
      UpdatePriceListSchema,
      SetDefaultPriceListSchema,
      CreatePriceListEntrySchema,
      UpdatePriceListEntrySchema,
      ClosePriceListEntrySchema,
      ListPriceListEntriesSchema,
      ResolveEffectivePriceSchema,
    ];
    for (const schema of schemas) {
      for (const key of AUTHORITY_KEYS) {
        expect(schemaKeys(schema), key).not.toContain(key);
      }
    }
  });

  it("preserves null versus absent on entry update", () => {
    const withNull = UpdatePriceListEntrySchema.parse({
      expectedVersion: 1,
      effectiveTo: null,
    });
    expect(withNull.effectiveTo).toBeNull();
    const absent = UpdatePriceListEntrySchema.parse({
      expectedVersion: 1,
      unitPrice: "1",
    });
    expect(absent.effectiveTo).toBeUndefined();
  });

  it("round-trips the effectiveFrom+id cursor and rejects corruption", () => {
    const at = parseCivilDate("2026-07-01");
    const encoded = encodeEffectiveFromIdCursor(at, "abc");
    expect(decodeEffectiveFromIdCursor(encoded)).toEqual({
      effectiveFrom: at,
      id: "abc",
    });
    expect(() => decodeEffectiveFromIdCursor("%%%")).toThrow(ValidationError);
    expect(() => decodeEffectiveFromIdCursor("not-a-cursor")).toThrow(ValidationError);
  });
});

describe("normaliseSearchTerm", () => {
  it("is identical under LANG=tr_TR.UTF-8", () => {
    const previous = process.env.LANG;
    process.env.LANG = "tr_TR.UTF-8";
    try {
      expect(normaliseSearchTerm("  I  ")).toBe("i");
      expect(normaliseSearchTerm("PL")).toBe("pl");
    } finally {
      if (previous === undefined) delete process.env.LANG;
      else process.env.LANG = previous;
    }
  });
});
