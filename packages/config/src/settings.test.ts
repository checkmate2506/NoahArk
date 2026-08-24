import { describe, expect, it } from "vitest";
import { validateTenantSettingValue, validateLegalEntitySettingValue } from "./settings";

describe("validateTenantSettingValue", () => {
  it("accepts a valid ui.defaultLanguage value", () => {
    expect(validateTenantSettingValue("ui.defaultLanguage", "EN")).toBe("EN");
  });

  it("rejects a language outside the approved SG/MY/ID language scope", () => {
    expect(() => validateTenantSettingValue("ui.defaultLanguage", "ZH")).toThrow(
      /Invalid value/,
    );
  });

  it("rejects an unregistered setting key", () => {
    expect(() => validateTenantSettingValue("worldwide.anyCountry", "x")).toThrow(
      /Unknown tenant setting key/,
    );
  });
});

describe("validateLegalEntitySettingValue", () => {
  it("accepts a valid documents.numberingPrefix value", () => {
    expect(validateLegalEntitySettingValue("documents.numberingPrefix", "INV")).toBe(
      "INV",
    );
  });

  it("rejects an over-long prefix", () => {
    expect(() =>
      validateLegalEntitySettingValue("documents.numberingPrefix", "WAY-TOO-LONG-PREFIX"),
    ).toThrow(/Invalid value/);
  });

  it("rejects an unregistered setting key", () => {
    expect(() => validateLegalEntitySettingValue("gst.rate", 0.09)).toThrow(
      /Unknown legal-entity setting key/,
    );
  });
});
