import { describe, expect, it } from "vitest";
import { assertTrustedOrigin, trustedOriginsFromEnv } from "./csrf";

function makeRequest(method: string, origin?: string): Request {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);
  return new Request("https://noahark.example/api/v1/tenants/t1", { method, headers });
}

describe("trustedOriginsFromEnv (F-8)", () => {
  it("includes AUTH_URL's own origin", () => {
    const origins = trustedOriginsFromEnv({
      NODE_ENV: "test",
      AUTH_URL: "https://app.noahark.example",
    });
    expect(origins.has("https://app.noahark.example")).toBe(true);
  });

  it("includes each TRUSTED_ORIGINS entry", () => {
    const origins = trustedOriginsFromEnv({
      NODE_ENV: "test",
      AUTH_URL: "https://app.noahark.example",
      TRUSTED_ORIGINS: "https://a.example, https://b.example",
    });
    expect(origins.has("https://a.example")).toBe(true);
    expect(origins.has("https://b.example")).toBe(true);
  });

  it("ignores a malformed TRUSTED_ORIGINS entry rather than throwing", () => {
    expect(() =>
      trustedOriginsFromEnv({
        NODE_ENV: "test",
        TRUSTED_ORIGINS: "not a url, https://ok.example",
      }),
    ).not.toThrow();
  });
});

describe("assertTrustedOrigin (F-8)", () => {
  const trusted = new Set(["https://app.noahark.example"]);

  it("allows a GET request regardless of Origin", () => {
    expect(() =>
      assertTrustedOrigin(makeRequest("GET", "https://evil.example"), trusted, true),
    ).not.toThrow();
  });

  it("allows a state-changing request from a trusted origin", () => {
    expect(() =>
      assertTrustedOrigin(
        makeRequest("POST", "https://app.noahark.example"),
        trusted,
        true,
      ),
    ).not.toThrow();
    expect(() =>
      assertTrustedOrigin(
        makeRequest("DELETE", "https://app.noahark.example"),
        trusted,
        true,
      ),
    ).not.toThrow();
  });

  it("rejects a state-changing request from an untrusted origin, in production", () => {
    expect(() =>
      assertTrustedOrigin(makeRequest("POST", "https://evil.example"), trusted, true),
    ).toThrow(/not trusted/);
  });

  it("rejects a state-changing request with no Origin header, in production", () => {
    expect(() => assertTrustedOrigin(makeRequest("POST"), trusted, true)).toThrow(
      /Missing Origin/,
    );
  });

  it("allows a missing Origin header outside production (dev/test tooling)", () => {
    expect(() => assertTrustedOrigin(makeRequest("POST"), trusted, false)).not.toThrow();
  });

  it("still rejects a PRESENT, mismatched origin outside production", () => {
    expect(() =>
      assertTrustedOrigin(makeRequest("POST", "https://evil.example"), trusted, false),
    ).toThrow(/not trusted/);
  });

  it("rejects PUT and PATCH from an untrusted origin too", () => {
    expect(() =>
      assertTrustedOrigin(makeRequest("PUT", "https://evil.example"), trusted, true),
    ).toThrow();
    expect(() =>
      assertTrustedOrigin(makeRequest("PATCH", "https://evil.example"), trusted, true),
    ).toThrow();
  });
});
