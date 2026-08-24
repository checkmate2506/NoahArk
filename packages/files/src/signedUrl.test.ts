import { describe, expect, it } from "vitest";
import {
  signFileAccess,
  verifyFileAccess,
  isWellFormedHexSignature,
  type SignedFileAccessInput,
} from "./signedUrl";

const SECRET = "test-secret-value-not-for-production";

function input(overrides: Partial<SignedFileAccessInput> = {}): SignedFileAccessInput {
  return {
    fileId: "file1",
    storageKey: "tenant/t1/file.pdf",
    version: 1,
    operation: "download",
    ...overrides,
  };
}

describe("signFileAccess / verifyFileAccess (F-15)", () => {
  it("verifies a freshly signed URL", () => {
    const { expiresAt, signature } = signFileAccess(input(), SECRET, 60);
    expect(verifyFileAccess(input(), expiresAt, signature, SECRET)).toBe(true);
  });

  it("rejects a signature for a different file ID", () => {
    const { expiresAt, signature } = signFileAccess(input(), SECRET, 60);
    expect(
      verifyFileAccess(input({ fileId: "file2" }), expiresAt, signature, SECRET),
    ).toBe(false);
  });

  it("rejects a signature for a different storage key", () => {
    const { expiresAt, signature } = signFileAccess(input(), SECRET, 60);
    expect(
      verifyFileAccess(
        input({ storageKey: "tenant/t1/other.pdf" }),
        expiresAt,
        signature,
        SECRET,
      ),
    ).toBe(false);
  });

  it("rejects a signature for a different (bumped) version", () => {
    const { expiresAt, signature } = signFileAccess(input({ version: 1 }), SECRET, 60);
    expect(verifyFileAccess(input({ version: 2 }), expiresAt, signature, SECRET)).toBe(
      false,
    );
  });

  it("rejects a signature for a different operation", () => {
    const { expiresAt, signature } = signFileAccess(input(), SECRET, 60);
    // @ts-expect-error — deliberately testing a forged/different operation value
    const forged = input({ operation: "upload" });
    expect(verifyFileAccess(forged, expiresAt, signature, SECRET)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const { expiresAt, signature } = signFileAccess(input(), SECRET, 60);
    const tampered =
      signature.slice(0, -2) + (signature.slice(-2) === "00" ? "11" : "00");
    expect(verifyFileAccess(input(), expiresAt, tampered, SECRET)).toBe(false);
  });

  it("rejects an expired URL", () => {
    const expiresAt = Date.now() - 1000;
    const { signature } = signFileAccess(input(), SECRET, -1);
    expect(verifyFileAccess(input(), expiresAt, signature, SECRET)).toBe(false);
  });

  it("rejects a signature produced with a different secret", () => {
    const { expiresAt, signature } = signFileAccess(input(), SECRET, 60);
    expect(verifyFileAccess(input(), expiresAt, signature, "wrong-secret")).toBe(false);
  });

  it("rejects a malformed (non-hex, wrong-length) signature without throwing", () => {
    const { expiresAt } = signFileAccess(input(), SECRET, 60);
    expect(() =>
      verifyFileAccess(input(), expiresAt, "not-hex-!!", SECRET),
    ).not.toThrow();
    expect(verifyFileAccess(input(), expiresAt, "not-hex-!!", SECRET)).toBe(false);
    expect(verifyFileAccess(input(), expiresAt, "ab", SECRET)).toBe(false);
    expect(verifyFileAccess(input(), expiresAt, "", SECRET)).toBe(false);
  });

  it("rejects a non-finite expiry without throwing", () => {
    const { signature } = signFileAccess(input(), SECRET, 60);
    expect(() => verifyFileAccess(input(), Number.NaN, signature, SECRET)).not.toThrow();
    expect(verifyFileAccess(input(), Number.NaN, signature, SECRET)).toBe(false);
  });
});

describe("isWellFormedHexSignature", () => {
  it("accepts a valid 64-char hex string", () => {
    expect(isWellFormedHexSignature("a".repeat(64))).toBe(true);
  });
  it("rejects the wrong length", () => {
    expect(isWellFormedHexSignature("a".repeat(63))).toBe(false);
    expect(isWellFormedHexSignature("a".repeat(65))).toBe(false);
  });
  it("rejects non-hex characters", () => {
    expect(isWellFormedHexSignature("z".repeat(64))).toBe(false);
  });
});
