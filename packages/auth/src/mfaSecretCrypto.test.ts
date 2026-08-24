import { describe, expect, it } from "vitest";
import { encryptMfaSecret, decryptMfaSecret } from "./mfaSecretCrypto";

describe("MFA secret encryption (F-3B)", () => {
  it("round-trips the plaintext secret", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const encrypted = encryptMfaSecret(secret, "test-auth-secret-at-least-32-chars-long");
    expect(decryptMfaSecret(encrypted, "test-auth-secret-at-least-32-chars-long")).toBe(
      secret,
    );
  });

  it("produces ciphertext that does not contain the plaintext secret", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const encrypted = encryptMfaSecret(secret, "test-auth-secret-at-least-32-chars-long");
    expect(encrypted).not.toContain(secret);
  });

  it("produces different ciphertext for the same secret on each call (random IV)", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const a = encryptMfaSecret(secret, "test-auth-secret-at-least-32-chars-long");
    const b = encryptMfaSecret(secret, "test-auth-secret-at-least-32-chars-long");
    expect(a).not.toBe(b);
  });

  it("fails to decrypt with the wrong key", () => {
    const encrypted = encryptMfaSecret(
      "JBSWY3DPEHPK3PXP",
      "correct-auth-secret-at-least-32-chars",
    );
    expect(() =>
      decryptMfaSecret(encrypted, "wrong-auth-secret-at-least-32-chars!!"),
    ).toThrow();
  });

  it("fails to decrypt tampered ciphertext (GCM auth tag catches it)", () => {
    const encrypted = encryptMfaSecret(
      "JBSWY3DPEHPK3PXP",
      "test-auth-secret-at-least-32-chars-long",
    );
    const parts = encrypted.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -2)}zz`;
    expect(() =>
      decryptMfaSecret(tampered, "test-auth-secret-at-least-32-chars-long"),
    ).toThrow();
  });

  it("rejects a malformed encrypted value", () => {
    expect(() =>
      decryptMfaSecret("not-a-valid-format", "test-auth-secret-at-least-32-chars-long"),
    ).toThrow(/malformed/i);
  });
});
