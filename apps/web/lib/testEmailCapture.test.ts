import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTestEmailCaptureActive, readCapturedEmails } from "./testEmailCapture";
import { GET } from "@/app/api/v1/test/email-captures/route";

/**
 * N-6 (Phase 1D): the closed-gate path was previously verified only
 * manually (Phase 1C's live probe) and never covered by an automated
 * test. It also corrects a factually inaccurate doc-comment claim
 * ("indistinguishable from a route that doesn't exist") — both this
 * file's original comment and route.ts's said so, but neither was ever
 * checked against what Next.js actually returns for a genuinely unmatched
 * route: a bare 404 with no JSON body, versus this endpoint's real
 * closed-gate response, which IS a fully-formed `{ error: { code:
 * "NOT_FOUND", message, requestId } }` envelope — same status code (404),
 * different (and inspectable) body. Still safe/inert either way — nothing
 * beyond "this path exists in the codebase" leaks, and every real
 * deployment sets NODE_ENV=production, which alone forces the closed path
 * regardless of TEST_NOTIFICATION_CAPTURE — but the claim itself was wrong
 * and is fixed in both doc comments alongside this test.
 */
/** `undefined` simulates "unset" — the code under test only ever checks
 * `=== "1"`, so stubbing to `""` is behaviourally identical to deleting
 * the variable, without fighting TypeScript's readonly `process.env`
 * typing or vitest's string-only `stubEnv` value type. */
function setEnv(nodeEnv: string | undefined, captureFlag: string | undefined) {
  vi.stubEnv("NODE_ENV", nodeEnv ?? "");
  vi.stubEnv("TEST_NOTIFICATION_CAPTURE", captureFlag ?? "");
}

describe("isTestEmailCaptureActive (N-6)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is active only with NODE_ENV!=production AND TEST_NOTIFICATION_CAPTURE=1", () => {
    setEnv("development", "1");
    expect(isTestEmailCaptureActive()).toBe(true);
    setEnv("test", "1");
    expect(isTestEmailCaptureActive()).toBe(true);
  });

  it("is inactive when TEST_NOTIFICATION_CAPTURE is unset", () => {
    setEnv("development", undefined);
    expect(isTestEmailCaptureActive()).toBe(false);
  });

  it('is inactive when TEST_NOTIFICATION_CAPTURE is any value other than exactly "1"', () => {
    for (const value of ["true", "TRUE", "yes", "01", " 1", "1 "]) {
      setEnv("development", value);
      expect(
        isTestEmailCaptureActive(),
        `expected false for TEST_NOTIFICATION_CAPTURE=${JSON.stringify(value)}`,
      ).toBe(false);
    }
  });

  it("is inactive in production even if TEST_NOTIFICATION_CAPTURE=1 is mistakenly left set", () => {
    setEnv("production", "1");
    expect(isTestEmailCaptureActive()).toBe(false);
  });
});

describe("readCapturedEmails — closed-gate path never touches the database (N-6)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null without throwing when the gate is closed (no DATABASE_URL required)", async () => {
    setEnv("production", "1");
    await expect(readCapturedEmails("someone@example.com")).resolves.toBeNull();
  });
});

describe("GET /api/v1/test/email-captures — closed-gate HTTP response (N-6)", () => {
  beforeEach(() => {
    setEnv("production", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("responds 404 with the app's own NOT_FOUND envelope, not an empty/bare 404", async () => {
    const req = new Request(
      "http://localhost/api/v1/test/email-captures?to=someone@example.com",
    );
    const res = await GET(req, { params: Promise.resolve({}) });

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body).toMatchObject({ error: { code: "NOT_FOUND" } });
    // The concrete, checkable half of the corrected claim: this body is a
    // real, structured JSON envelope — not empty, not HTML — which is what
    // actually distinguishes it from Next.js's own unmatched-route 404.
    expect(typeof body.error.code).toBe("string");
    expect(typeof body.error.message).toBe("string");
    expect(typeof body.error.requestId).toBe("string");
  });

  it("P1E-3: a malformed query gets the SAME 404 as a well-formed one — the gate is checked first, so neither ever reaches validation", async () => {
    const malformed = await GET(
      new Request("http://localhost/api/v1/test/email-captures?to=not-an-email"),
      { params: Promise.resolve({}) },
    );
    const wellFormed = await GET(
      new Request("http://localhost/api/v1/test/email-captures?to=someone@example.com"),
      { params: Promise.resolve({}) },
    );
    const noQuery = await GET(
      new Request("http://localhost/api/v1/test/email-captures"),
      { params: Promise.resolve({}) },
    );
    for (const res of [malformed, wellFormed, noQuery]) {
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    }
  });
});

describe("GET /api/v1/test/email-captures — open-gate validation still runs (P1E-3)", () => {
  beforeEach(() => {
    setEnv("test", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the ordinary 422 VALIDATION_FAILED for a malformed query once the gate is open", async () => {
    const req = new Request(
      "http://localhost/api/v1/test/email-captures?to=not-an-email",
    );
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns the ordinary 422 for a missing query once the gate is open", async () => {
    const req = new Request("http://localhost/api/v1/test/email-captures");
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(422);
  });
});
