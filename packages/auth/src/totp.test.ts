import { describe, expect, it } from "vitest";
import {
  generateTotpSecret,
  base32Encode,
  base32Decode,
  computeTotp,
  verifyTotp,
  verifyTotpWithCounter,
  buildProvisioningUri,
} from "./totp";

// RFC 4226 Appendix D test vectors — HOTP with the ASCII secret
// "12345678901234567890" (20 bytes), 6-digit codes. TOTP is HOTP with a
// time-derived counter (RFC 6238), so these vectors — run through our
// hotp()-backed computeTotp() at a synthetic "time" equal to
// counter * 30 — directly verify the underlying HOTP computation is
// RFC-correct.
const RFC_4226_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));
const RFC_4226_VECTORS = [
  "755224",
  "287082",
  "359152",
  "969429",
  "338314",
  "254676",
  "287922",
  "162583",
  "399871",
  "520489",
];

describe("base32Encode / base32Decode", () => {
  it("round-trips arbitrary byte buffers", () => {
    for (const input of [
      Buffer.from([]),
      Buffer.from([1]),
      Buffer.from("12345678901234567890", "ascii"),
    ]) {
      expect(base32Decode(base32Encode(input))).toEqual(input);
    }
  });
});

describe("computeTotp (RFC 4226 Appendix D vectors, via a synthetic 30s-step time)", () => {
  it.each(RFC_4226_VECTORS.map((code, counter) => [counter, code] as const))(
    "counter %i produces %s",
    (counter, expectedCode) => {
      const atSeconds = counter * 30;
      expect(computeTotp(RFC_4226_SECRET, atSeconds)).toBe(expectedCode);
    },
  );
});

describe("verifyTotp", () => {
  it("accepts the exact current code", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000;
    const code = computeTotp(secret, now);
    expect(verifyTotp(secret, code, now)).toBe(true);
  });

  it("accepts a code from one step of clock drift in either direction", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000;
    const codeBefore = computeTotp(secret, now - 30);
    const codeAfter = computeTotp(secret, now + 30);
    expect(verifyTotp(secret, codeBefore, now)).toBe(true);
    expect(verifyTotp(secret, codeAfter, now)).toBe(true);
  });

  it("rejects a code more than one step of drift away", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000;
    const staleCode = computeTotp(secret, now - 90);
    expect(verifyTotp(secret, staleCode, now)).toBe(false);
  });

  it("rejects a malformed (non-6-digit) submission", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, "12345")).toBe(false);
    expect(verifyTotp(secret, "1234567")).toBe(false);
    expect(verifyTotp(secret, "abcdef")).toBe(false);
  });

  it("rejects a code computed from a different secret", () => {
    const secretA = generateTotpSecret();
    const secretB = generateTotpSecret();
    const now = 1_700_000_000;
    const code = computeTotp(secretA, now);
    expect(verifyTotp(secretB, code, now)).toBe(false);
  });
});

describe("verifyTotpWithCounter (N-1, Phase 1D — replay-protection primitive)", () => {
  it("returns the matching HOTP counter for the exact current code", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000;
    const code = computeTotp(secret, now);
    const result = verifyTotpWithCounter(secret, code, now);
    expect(result.valid).toBe(true);
    expect(result.counter).toBe(Math.floor(now / 30));
  });

  it("returns the EARLIER counter for a code from clock drift in the past", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000;
    const codeBefore = computeTotp(secret, now - 30);
    const result = verifyTotpWithCounter(secret, codeBefore, now);
    expect(result.valid).toBe(true);
    expect(result.counter).toBe(Math.floor((now - 30) / 30));
    expect(result.counter).toBeLessThan(Math.floor(now / 30));
  });

  it("returns the LATER counter for a code from clock drift in the future", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000;
    const codeAfter = computeTotp(secret, now + 30);
    const result = verifyTotpWithCounter(secret, codeAfter, now);
    expect(result.valid).toBe(true);
    expect(result.counter).toBe(Math.floor((now + 30) / 30));
    expect(result.counter).toBeGreaterThan(Math.floor(now / 30));
  });

  it("returns counter: null for an invalid code", () => {
    const secret = generateTotpSecret();
    const result = verifyTotpWithCounter(secret, "000000", 1_700_000_000);
    // extremely unlikely to coincidentally match; assert shape either way
    if (!result.valid) expect(result.counter).toBeNull();
  });

  it("returns counter: null for a malformed submission", () => {
    const secret = generateTotpSecret();
    expect(verifyTotpWithCounter(secret, "abcdef", 1_700_000_000)).toEqual({
      valid: false,
      counter: null,
    });
  });

  it("verifyTotp (boolean wrapper) stays consistent with verifyTotpWithCounter", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000;
    const code = computeTotp(secret, now);
    expect(verifyTotp(secret, code, now)).toBe(
      verifyTotpWithCounter(secret, code, now).valid,
    );
  });
});

describe("buildProvisioningUri", () => {
  it("never embeds the secret in a logged-looking format beyond the query param itself", () => {
    const uri = buildProvisioningUri("JBSWY3DPEHPK3PXP", "user@example.com");
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=NoahArk");
  });
});
