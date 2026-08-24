import { describe, expect, it } from "vitest";
import { generateRecoveryCodes, hashRecoveryCode } from "./recoveryCodes";

describe("generateRecoveryCodes (F-3B)", () => {
  it("generates 10 unique codes by default", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });

  it("generates a custom count", () => {
    expect(generateRecoveryCodes(3)).toHaveLength(3);
  });
});

describe("hashRecoveryCode", () => {
  it("is deterministic and case/whitespace-insensitive", () => {
    const a = hashRecoveryCode("ABCDE-12345");
    const b = hashRecoveryCode(" abcde-12345 ");
    expect(a).toBe(b);
  });

  it("produces different hashes for different codes", () => {
    expect(hashRecoveryCode("AAAAA-11111")).not.toBe(hashRecoveryCode("BBBBB-22222"));
  });
});
