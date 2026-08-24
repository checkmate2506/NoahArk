import { describe, expect, it } from "vitest";
import {
  isJurisdiction,
  isCurrency,
  isLanguage,
  functionalCurrencyFor,
  assertJurisdictionCurrencyCompatible,
} from "./jurisdiction";

describe("isJurisdiction", () => {
  it("accepts SG, MY, ID", () => {
    expect(isJurisdiction("SG")).toBe(true);
    expect(isJurisdiction("MY")).toBe(true);
    expect(isJurisdiction("ID")).toBe(true);
  });

  it("rejects any jurisdiction outside the approved three-country scope", () => {
    expect(isJurisdiction("US")).toBe(false);
    expect(isJurisdiction("TH")).toBe(false);
    expect(isJurisdiction("")).toBe(false);
    expect(isJurisdiction(undefined)).toBe(false);
  });
});

describe("isCurrency / isLanguage", () => {
  it("accepts only SGD/MYR/IDR", () => {
    expect(isCurrency("SGD")).toBe(true);
    expect(isCurrency("USD")).toBe(false);
  });

  it("accepts only EN/MS/ID", () => {
    expect(isLanguage("EN")).toBe(true);
    expect(isLanguage("ZH")).toBe(false);
  });
});

describe("functionalCurrencyFor", () => {
  it("maps each jurisdiction to its one functional currency", () => {
    expect(functionalCurrencyFor("SG")).toBe("SGD");
    expect(functionalCurrencyFor("MY")).toBe("MYR");
    expect(functionalCurrencyFor("ID")).toBe("IDR");
  });
});

describe("assertJurisdictionCurrencyCompatible", () => {
  it("accepts every correct jurisdiction/currency pairing", () => {
    expect(() => assertJurisdictionCurrencyCompatible("SG", "SGD")).not.toThrow();
    expect(() => assertJurisdictionCurrencyCompatible("MY", "MYR")).not.toThrow();
    expect(() => assertJurisdictionCurrencyCompatible("ID", "IDR")).not.toThrow();
  });

  it("rejects every cross-jurisdiction mismatch", () => {
    expect(() => assertJurisdictionCurrencyCompatible("SG", "MYR")).toThrow(
      /requires functional currency SGD/,
    );
    expect(() => assertJurisdictionCurrencyCompatible("SG", "IDR")).toThrow(
      /requires functional currency SGD/,
    );
    expect(() => assertJurisdictionCurrencyCompatible("MY", "SGD")).toThrow(
      /requires functional currency MYR/,
    );
    expect(() => assertJurisdictionCurrencyCompatible("MY", "IDR")).toThrow(
      /requires functional currency MYR/,
    );
    expect(() => assertJurisdictionCurrencyCompatible("ID", "SGD")).toThrow(
      /requires functional currency IDR/,
    );
    expect(() => assertJurisdictionCurrencyCompatible("ID", "MYR")).toThrow(
      /requires functional currency IDR/,
    );
  });
});
