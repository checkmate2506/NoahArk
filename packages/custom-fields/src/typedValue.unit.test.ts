import { describe, expect, it } from "vitest";
import { Prisma } from "@noahark/db";
import { ValidationError } from "@noahark/core";
import {
  canonicalizeEnvelope,
  canonicalizeOptions,
  envelopeToStorage,
  formatCivilDate,
  formatDecimal,
  parseCivilDate,
  parseSignedDecimalString,
} from "./typedValue";

describe("typed custom-field values", () => {
  it("trims STRING values and bounds length", () => {
    expect(
      canonicalizeEnvelope({ dataType: "STRING", value: "  hello  " }, "STRING", null),
    ).toEqual({ dataType: "STRING", value: "hello" });
    expect(() =>
      canonicalizeEnvelope({ dataType: "STRING", value: "   " }, "STRING", null),
    ).toThrow(ValidationError);
    expect(() =>
      canonicalizeEnvelope(
        { dataType: "STRING", value: "x".repeat(2001) },
        "STRING",
        null,
      ),
    ).toThrow(ValidationError);
  });

  it("accepts INTEGER int4 values and rejects non-integers", () => {
    expect(
      canonicalizeEnvelope({ dataType: "INTEGER", value: 0 }, "INTEGER", null).value,
    ).toBe(0);
    expect(
      canonicalizeEnvelope({ dataType: "INTEGER", value: -2147483648 }, "INTEGER", null)
        .value,
    ).toBe(-2147483648);
    expect(
      canonicalizeEnvelope({ dataType: "INTEGER", value: 2147483647 }, "INTEGER", null)
        .value,
    ).toBe(2147483647);
    expect(() =>
      canonicalizeEnvelope({ dataType: "INTEGER", value: 1.5 }, "INTEGER", null),
    ).toThrow(ValidationError);
    expect(() =>
      canonicalizeEnvelope({ dataType: "INTEGER", value: Number.NaN }, "INTEGER", null),
    ).toThrow(ValidationError);
    expect(() =>
      canonicalizeEnvelope({ dataType: "INTEGER", value: 2147483648 }, "INTEGER", null),
    ).toThrow(ValidationError);
  });

  it("parses signed NUMERIC(23,6) DECIMAL strings without the pricing parser", () => {
    expect(parseSignedDecimalString("0")).toBe("0");
    expect(parseSignedDecimalString("-12.5")).toBe("-12.5");
    expect(parseSignedDecimalString("99999999999999999.999999")).toBe(
      "99999999999999999.999999",
    );
    const rejected = [
      "",
      " ",
      "-0",
      "-0.0",
      "+1",
      "1e5",
      "1E5",
      "01",
      "1,5",
      ".5",
      "5.",
      "1.0000001",
      "999999999999999999",
    ];
    for (const raw of rejected) {
      expect(() => parseSignedDecimalString(raw), raw).toThrow(ValidationError);
    }
  });

  it("formats DECIMAL storage to 6 fractional digits", () => {
    expect(formatDecimal(new Prisma.Decimal("-12.5"))).toBe("-12.500000");
  });

  it("accepts BOOLEAN only as boolean", () => {
    expect(
      canonicalizeEnvelope({ dataType: "BOOLEAN", value: false }, "BOOLEAN", null).value,
    ).toBe(false);
  });

  it("validates DATE as a timezone-independent civil day", () => {
    expect(formatCivilDate(parseCivilDate("2026-07-01"))).toBe("2026-07-01");
    expect(formatCivilDate(parseCivilDate("2024-02-29"))).toBe("2024-02-29");
    expect(() => parseCivilDate("2026-02-29")).toThrow(ValidationError);
    expect(() => parseCivilDate("2026-7-1")).toThrow(ValidationError);
  });

  it("requires SINGLE_SELECT to match locked options exactly", () => {
    expect(
      canonicalizeEnvelope({ dataType: "SINGLE_SELECT", value: "red" }, "SINGLE_SELECT", [
        "red",
        "blue",
      ]).value,
    ).toBe("red");
    expect(() =>
      canonicalizeEnvelope(
        { dataType: "SINGLE_SELECT", value: "green" },
        "SINGLE_SELECT",
        ["red", "blue"],
      ),
    ).toThrow(ValidationError);
    expect(() =>
      canonicalizeEnvelope({ dataType: "SINGLE_SELECT", value: "red" }, "SINGLE_SELECT", [
        "Red",
      ]),
    ).toThrow(ValidationError);
  });

  it("rejects a tagged envelope that does not match the locked data type", () => {
    expect(() =>
      canonicalizeEnvelope({ dataType: "STRING", value: "x" }, "INTEGER", null),
    ).toThrow(ValidationError);
  });

  it("populates exactly one typed storage column", () => {
    const stored = envelopeToStorage({ dataType: "STRING", value: "hello" });
    expect(stored.value).toBe(Prisma.DbNull);
    expect(stored.valueText).toBe("hello");
    expect(stored.valueInteger).toBeNull();
    expect(stored.valueDecimal).toBeNull();
    expect(stored.valueBoolean).toBeNull();
    expect(stored.valueDate).toBeNull();
    expect(stored.valueOption).toBeNull();
  });

  it("canonicalizes SINGLE_SELECT options", () => {
    expect(canonicalizeOptions(["  a  ", "b"])).toEqual(["a", "b"]);
    expect(() => canonicalizeOptions([])).toThrow(ValidationError);
    expect(() => canonicalizeOptions(["a", "a"])).toThrow(ValidationError);
    expect(() => canonicalizeOptions(["  "])).toThrow(ValidationError);
  });
});
