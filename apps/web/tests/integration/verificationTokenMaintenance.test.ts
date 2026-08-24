import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSystemClient } from "@noahark/db/system";
import { cleanupExpiredVerificationTokens } from "@/lib/verificationTokenMaintenance";

/**
 * N-5 (Phase 1D): VerificationToken previously had no retention path at
 * all for a token that is never consumed (an email link never clicked, an
 * MFA challenge abandoned mid-sign-in) — it just accumulated forever.
 */
describe("cleanupExpiredVerificationTokens (N-5)", () => {
  it("deletes only tokens whose expires timestamp has passed", async () => {
    const db = createSystemClient();
    const now = Date.now();

    const expired = await db.verificationToken.create({
      data: {
        identifier: `test-expired:${randomUUID()}`,
        token: randomUUID(),
        expires: new Date(now - 60_000),
      },
    });
    const stillValid = await db.verificationToken.create({
      data: {
        identifier: `test-valid:${randomUUID()}`,
        token: randomUUID(),
        expires: new Date(now + 60_000),
      },
    });

    const deletedCount = await cleanupExpiredVerificationTokens(now);
    expect(deletedCount).toBeGreaterThanOrEqual(1);

    expect(
      await db.verificationToken.findUnique({ where: { token: expired.token } }),
    ).toBeNull();
    expect(
      await db.verificationToken.findUnique({ where: { token: stillValid.token } }),
    ).not.toBeNull();

    await db.verificationToken.deleteMany({ where: { token: stillValid.token } });
  });

  it("leaves a not-yet-expired token untouched", async () => {
    const db = createSystemClient();
    const now = Date.now();
    const future = await db.verificationToken.create({
      data: {
        identifier: `test-future:${randomUUID()}`,
        token: randomUUID(),
        expires: new Date(now + 3_600_000),
      },
    });

    // Runs the real cleanup at the real "now" — may legitimately delete
    // OTHER expired rows left over from unrelated tests/prior sessions;
    // this test only asserts its OWN fixture survives, not a global count.
    await cleanupExpiredVerificationTokens(now);
    expect(
      await db.verificationToken.findUnique({ where: { token: future.token } }),
    ).not.toBeNull();

    await db.verificationToken.deleteMany({ where: { token: future.token } });
  });
});
