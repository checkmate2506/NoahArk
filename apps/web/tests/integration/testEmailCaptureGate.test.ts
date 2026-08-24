import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getSharedEmailProvider, readCapturedEmails } from "@/lib/testEmailCapture";
import { GET } from "@/app/api/v1/test/email-captures/route";

/**
 * N-6 (Phase 1D): open-gate counterpart to lib/testEmailCapture.test.ts's
 * closed-gate coverage. This suite's own env (apps/web/.env) has
 * NODE_ENV=test and TEST_NOTIFICATION_CAPTURE=1 — the same activation
 * state real E2E runs use — so `isTestEmailCaptureActive()` is genuinely
 * true here, exercising the real database-backed path rather than mocking
 * it.
 */
describe("test-capture gate — open path (N-6)", () => {
  it("readCapturedEmails returns a message sent through the shared provider", async () => {
    const to = `n6-${randomUUID()}@test.noahark.local`;
    await getSharedEmailProvider().send({
      to,
      subject: "N-6 gate test",
      body: "hello from the open-gate test",
    });

    const captures = await readCapturedEmails(to);
    expect(captures).not.toBeNull();
    expect(captures!.length).toBeGreaterThanOrEqual(1);
    expect(captures![0]!.subject).toBe("N-6 gate test");
  });

  it("GET /api/v1/test/email-captures returns 200 with the captured message", async () => {
    const to = `n6-route-${randomUUID()}@test.noahark.local`;
    await getSharedEmailProvider().send({
      to,
      subject: "N-6 route test",
      body: "token=abc123",
    });

    const req = new Request(
      `http://localhost/api/v1/test/email-captures?to=${encodeURIComponent(to)}`,
    );
    const res = await GET(req, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.captures.length).toBeGreaterThanOrEqual(1);
    expect(body.data.captures[0].to).toBe(to);
  });

  it("returns an empty array (not null, not 404) for a recipient with no captures", async () => {
    const to = `n6-empty-${randomUUID()}@test.noahark.local`;
    const captures = await readCapturedEmails(to);
    expect(captures).toEqual([]);
  });
});
