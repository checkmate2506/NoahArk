import { describe, expect, it } from "vitest";
import { sanitizeForAudit } from "./sanitize";

describe("sanitizeForAudit", () => {
  it("redacts denylisted keys at the top level", () => {
    const result = sanitizeForAudit({ email: "a@b.com", password: "hunter2" }) as Record<
      string,
      unknown
    >;
    expect(result.email).toBe("a@b.com");
    expect(result.password).toBe("[REDACTED]");
  });

  it("redacts denylisted keys at nested depths", () => {
    const result = sanitizeForAudit({
      user: { profile: { passwordHash: "abc123", displayName: "Ada" } },
    }) as {
      user: { profile: { passwordHash: string; displayName: string } };
    };
    expect(result.user.profile.passwordHash).toBe("[REDACTED]");
    expect(result.user.profile.displayName).toBe("Ada");
  });

  it("redacts an entire container keyed literally 'credential' (F-29) rather than only its leaves", () => {
    // "credential" is itself denylisted (a generic credential container is
    // treated as sensitive as a whole) — so a nested object under that key,
    // including otherwise-safe fields like `algorithm`, is fully redacted
    // rather than selectively scrubbed. Stricter is correct here: no
    // service needs to audit password-credential metadata at all.
    const result = sanitizeForAudit({
      user: { credential: { passwordHash: "abc123", algorithm: "argon2id" } },
    }) as { user: { credential: unknown } };
    expect(result.user.credential).toBe("[REDACTED]");
  });

  it("redacts session tokens and API secrets regardless of casing", () => {
    const result = sanitizeForAudit({
      sessionToken: "s1",
      SESSION_TOKEN: "s2",
      apiKey: "k1",
      access_token: "t1",
    }) as Record<string, unknown>;
    expect(result.sessionToken).toBe("[REDACTED]");
    expect(result.SESSION_TOKEN).toBe("[REDACTED]");
    expect(result.apiKey).toBe("[REDACTED]");
    expect(result.access_token).toBe("[REDACTED]");
  });

  it("redacts denylisted keys inside arrays", () => {
    const result = sanitizeForAudit([{ token: "t1" }, { token: "t2" }]) as Array<
      Record<string, unknown>
    >;
    expect(result[0]?.token).toBe("[REDACTED]");
    expect(result[1]?.token).toBe("[REDACTED]");
  });

  it("passes through primitives and null/undefined unchanged", () => {
    expect(sanitizeForAudit(null)).toBeNull();
    expect(sanitizeForAudit(undefined)).toBeUndefined();
    expect(sanitizeForAudit(42)).toBe(42);
    expect(sanitizeForAudit("plain")).toBe("plain");
  });

  it("serializes Date values to ISO strings", () => {
    const d = new Date("2026-01-01T00:00:00.000Z");
    expect(sanitizeForAudit(d)).toBe("2026-01-01T00:00:00.000Z");
  });

  it("truncates beyond the max recursion depth instead of throwing", () => {
    let deep: unknown = { leaf: "value" };
    for (let i = 0; i < 10; i++) deep = { nested: deep };
    expect(() => sanitizeForAudit(deep)).not.toThrow();
  });

  it("redacts MFA and recovery-code material (F-29)", () => {
    const result = sanitizeForAudit({
      totpSecret: "JBSWY3DPEHPK3PXP",
      totp_secret: "JBSWY3DPEHPK3PXP",
      recoveryCodes: ["a", "b"],
      recovery_code: "c",
      otp: "123456",
    }) as Record<string, unknown>;
    expect(result.totpSecret).toBe("[REDACTED]");
    expect(result.totp_secret).toBe("[REDACTED]");
    expect(result.recoveryCodes).toBe("[REDACTED]");
    expect(result.recovery_code).toBe("[REDACTED]");
    expect(result.otp).toBe("[REDACTED]");
  });

  it("redacts cookies, authorization headers, and generic credential keys (F-29)", () => {
    const result = sanitizeForAudit({
      cookie: "noahark_session=abc",
      Authorization: "Bearer abc",
      credential: { x: 1 },
    }) as Record<string, unknown>;
    expect(result.cookie).toBe("[REDACTED]");
    expect(result.Authorization).toBe("[REDACTED]");
    expect(result.credential).toBe("[REDACTED]");
  });

  it("redacts national identifiers (NRIC/NIK) regardless of casing or separators (F-29)", () => {
    const result = sanitizeForAudit({
      nric: "S1234567D",
      NIK: "12345",
      n_r_i_c: "x",
    }) as Record<string, unknown>;
    expect(result.nric).toBe("[REDACTED]");
    expect(result.NIK).toBe("[REDACTED]");
    expect(result.n_r_i_c).toBe("[REDACTED]");
  });

  it("matches denylisted keys structurally regardless of separator style (F-29)", () => {
    const result = sanitizeForAudit({
      "password-hash": "x",
      password_hash: "y",
      passwordHash: "z",
    }) as Record<string, unknown>;
    expect(result["password-hash"]).toBe("[REDACTED]");
    expect(result.password_hash).toBe("[REDACTED]");
    expect(result.passwordHash).toBe("[REDACTED]");
  });
});
