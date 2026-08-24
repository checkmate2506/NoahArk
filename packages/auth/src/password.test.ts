import { describe, expect, it } from "vitest";
import {
  checkPasswordStrength,
  hashPassword,
  verifyPassword,
  PASSWORD_ALGORITHM,
  DUMMY_PASSWORD_HASH,
} from "./password";

describe("checkPasswordStrength", () => {
  it("rejects passwords shorter than the minimum length", () => {
    expect(checkPasswordStrength("short").ok).toBe(false);
  });

  it("accepts a sufficiently long password", () => {
    expect(checkPasswordStrength("correct-horse-battery-staple").ok).toBe(true);
  });
});

describe("hashPassword / verifyPassword", () => {
  it("produces an argon2id hash", async () => {
    const h = await hashPassword("correct-horse-battery-staple");
    expect(h).toMatch(/^\$argon2id\$/);
  });

  it("verifies the correct password against its own hash", async () => {
    const h = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPassword(h, "correct-horse-battery-staple")).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const h = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPassword(h, "wrong-password")).toBe(false);
  });

  it("produces a different hash for the same password on each call (unique salt)", async () => {
    const h1 = await hashPassword("correct-horse-battery-staple");
    const h2 = await hashPassword("correct-horse-battery-staple");
    expect(h1).not.toBe(h2);
  });

  it("exports the algorithm name for storage alongside the hash", () => {
    expect(PASSWORD_ALGORITHM).toBe("argon2id");
  });
});

describe("DUMMY_PASSWORD_HASH (F-9)", () => {
  it("is a genuinely valid argon2id hash verify() can run against", async () => {
    expect(DUMMY_PASSWORD_HASH).toMatch(/^\$argon2id\$/);
    // Any real password will (overwhelmingly likely) fail against it —
    // what matters is that verify() completes without throwing, at the
    // same cost as a real comparison.
    await expect(verifyPassword(DUMMY_PASSWORD_HASH, "some-random-guess")).resolves.toBe(
      false,
    );
  });

  it("takes comparable time to a real verification (no fast-path bailout)", async () => {
    const realHash = await hashPassword("correct-horse-battery-staple");

    const t0 = performance.now();
    await verifyPassword(realHash, "wrong-guess");
    const realDurationMs = performance.now() - t0;

    const t1 = performance.now();
    await verifyPassword(DUMMY_PASSWORD_HASH, "wrong-guess");
    const dummyDurationMs = performance.now() - t1;

    // Both are real Argon2id computations with the same parameters — this
    // is a sanity check that the dummy path isn't somehow short-circuited,
    // not a strict timing-attack proof (CI timing has too much jitter for
    // that). A 10x discrepancy would indicate something is badly wrong.
    expect(dummyDurationMs).toBeGreaterThan(realDurationMs / 10);
    expect(dummyDurationMs).toBeLessThan(realDurationMs * 10);
  });
});
