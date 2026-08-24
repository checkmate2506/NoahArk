import { describe, expect, it } from "vitest";
import { omitUndefined } from "./omitUndefined";

describe("omitUndefined", () => {
  it("removes keys whose value is undefined", () => {
    expect(omitUndefined({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it("keeps keys whose value is null (distinct from undefined)", () => {
    expect(omitUndefined({ a: null, b: undefined })).toEqual({ a: null });
  });

  it("keeps falsy-but-defined values", () => {
    expect(omitUndefined({ a: 0, b: "", c: false, d: undefined })).toEqual({
      a: 0,
      b: "",
      c: false,
    });
  });

  it("returns an empty object when everything is undefined", () => {
    expect(omitUndefined({ a: undefined, b: undefined })).toEqual({});
  });
});
