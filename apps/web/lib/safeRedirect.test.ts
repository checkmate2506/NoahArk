import { describe, expect, it } from "vitest";
import { sanitizeCallbackUrl } from "./safeRedirect";

describe("sanitizeCallbackUrl (F-5)", () => {
  it("accepts a plain relative path", () => {
    expect(sanitizeCallbackUrl("/app/tenant-1/settings")).toBe("/app/tenant-1/settings");
  });

  it("accepts a relative path with a query string", () => {
    expect(sanitizeCallbackUrl("/app/tenant-1?tab=roles")).toBe(
      "/app/tenant-1?tab=roles",
    );
  });

  it("falls back to /app for null/undefined/empty input", () => {
    expect(sanitizeCallbackUrl(null)).toBe("/app");
    expect(sanitizeCallbackUrl(undefined)).toBe("/app");
    expect(sanitizeCallbackUrl("")).toBe("/app");
    expect(sanitizeCallbackUrl("   ")).toBe("/app");
  });

  it("rejects an absolute external URL", () => {
    expect(sanitizeCallbackUrl("https://evil.example")).toBe("/app");
    expect(sanitizeCallbackUrl("http://evil.example/phish")).toBe("/app");
  });

  it("rejects a protocol-relative URL", () => {
    expect(sanitizeCallbackUrl("//evil.example")).toBe("/app");
    expect(sanitizeCallbackUrl("///evil.example")).toBe("/app");
  });

  it("rejects a backslash-prefixed value (browser protocol-relative trick)", () => {
    expect(sanitizeCallbackUrl("/\\evil.example")).toBe("/app");
  });

  it("rejects a path not starting with a slash", () => {
    expect(sanitizeCallbackUrl("evil.example")).toBe("/app");
    expect(sanitizeCallbackUrl("javascript:alert(1)")).toBe("/app");
  });

  it("rejects a percent-encoded bypass that decodes to a protocol-relative URL", () => {
    expect(sanitizeCallbackUrl("/%2F%2Fevil.example")).toBe("/app");
    expect(sanitizeCallbackUrl("/%2f%2fevil.example")).toBe("/app");
  });

  it("falls back safely on malformed percent-encoding rather than throwing", () => {
    expect(sanitizeCallbackUrl("/%")).toBe("/app");
  });

  it("honours a custom fallback", () => {
    expect(sanitizeCallbackUrl("https://evil.example", "/sign-in")).toBe("/sign-in");
  });
});
