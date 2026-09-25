import { describe, expect, it } from "vitest";
import { ValidationError } from "@noahark/core";
import { civilDateToString, decimalToString, timestampToIso } from "./dto";

describe("decimalToString", () => {
  it("returns an exact decimal string from a decimal-compatible value", () => {
    expect(decimalToString({ toString: () => "19.990000" })).toBe("19.990000");
  });

  it("preserves negative and six-decimal values", () => {
    expect(decimalToString({ toString: () => "-123.456789" })).toBe("-123.456789");
    expect(decimalToString("-0.000001")).toBe("-0.000001");
  });

  it("rejects JavaScript numbers", () => {
    expect(() => decimalToString(19.99)).toThrow(ValidationError);
  });

  it("rejects invalid decimal strings", () => {
    expect(() => decimalToString("1e6")).toThrow(ValidationError);
    expect(() => decimalToString("NaN")).toThrow(ValidationError);
    expect(() => decimalToString("01.2")).toThrow(ValidationError);
  });

  it("does not mutate the source object", () => {
    const source = { toString: () => "10.500000", extra: 1 };
    const frozen = Object.freeze({ ...source });
    expect(decimalToString(frozen)).toBe("10.500000");
    expect(frozen.extra).toBe(1);
  });
});

describe("civilDateToString", () => {
  it("formats UTC civil components as YYYY-MM-DD", () => {
    expect(civilDateToString(new Date("2026-09-22T23:15:00.000Z"))).toBe("2026-09-22");
    expect(civilDateToString(new Date("2026-01-02T00:00:00.000Z"))).toBe("2026-01-02");
  });

  it("rejects invalid dates", () => {
    expect(() => civilDateToString(new Date("not-a-date"))).toThrow(ValidationError);
    expect(() => civilDateToString("2026-09-22")).toThrow(ValidationError);
  });

  it("does not mutate the source Date", () => {
    const source = new Date("2026-09-22T12:00:00.000Z");
    const ms = source.getTime();
    expect(civilDateToString(source)).toBe("2026-09-22");
    expect(source.getTime()).toBe(ms);
  });
});

describe("timestampToIso", () => {
  it("formats an instant as ISO-8601", () => {
    const source = new Date("2026-09-22T17:14:07.123Z");
    expect(timestampToIso(source)).toBe("2026-09-22T17:14:07.123Z");
  });

  it("rejects invalid dates", () => {
    expect(() => timestampToIso(new Date(Number.NaN))).toThrow(ValidationError);
  });

  it("does not mutate the source Date and does not emit a civil date", () => {
    const source = new Date("2026-09-22T23:15:00.000Z");
    const ms = source.getTime();
    expect(timestampToIso(source)).toBe("2026-09-22T23:15:00.000Z");
    expect(timestampToIso(source)).not.toBe("2026-09-22");
    expect(source.getTime()).toBe(ms);
  });
});
