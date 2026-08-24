import { afterEach, describe, expect, it } from "vitest";
import { createSystemClient } from "@noahark/db/system";
import { InMemoryEmailProvider } from "@noahark/notifications";
import {
  requestEmailVerification,
  confirmEmailVerification,
} from "@/lib/services/emailVerificationService";
import { createTestUser, cleanupUser } from "./testHelpers";

describe("email verification (F-3A, real Postgres)", () => {
  let userIds: string[] = [];

  afterEach(async () => {
    for (const id of userIds) await cleanupUser(id);
    userIds = [];
  });

  async function captureRawToken(userId: string): Promise<string> {
    const provider = new InMemoryEmailProvider();
    await requestEmailVerification(userId, provider);
    const body = provider.sent.at(-1)?.body ?? "";
    const match = /token=([^\s&]+)/.exec(body);
    return match?.[1] ?? "";
  }

  it("verifies a user's email end to end", async () => {
    const user = await createTestUser();
    userIds.push(user.id);

    const rawToken = await captureRawToken(user.id);
    expect(rawToken).not.toBe("");

    await confirmEmailVerification(rawToken);

    const db = createSystemClient();
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.emailVerified).not.toBeNull();
  });

  it("is single-use — the same token cannot be confirmed twice", async () => {
    const user = await createTestUser();
    userIds.push(user.id);
    const rawToken = await captureRawToken(user.id);

    await confirmEmailVerification(rawToken);
    await expect(confirmEmailVerification(rawToken)).rejects.toThrow(
      /invalid or expired/i,
    );
  });

  it("rejects an unknown token with a generic error", async () => {
    await expect(confirmEmailVerification("not-a-real-token")).rejects.toThrow(
      /invalid or expired/i,
    );
  });

  it("resending a verification request invalidates the previous token", async () => {
    const user = await createTestUser();
    userIds.push(user.id);

    const firstToken = await captureRawToken(user.id);
    const secondToken = await captureRawToken(user.id);
    expect(secondToken).not.toBe(firstToken);

    await expect(confirmEmailVerification(firstToken)).rejects.toThrow(
      /invalid or expired/i,
    );
    await confirmEmailVerification(secondToken); // still valid
  });

  it("is a no-op for an already-verified user (idempotent, no duplicate token accumulation)", async () => {
    const user = await createTestUser();
    userIds.push(user.id);
    const rawToken = await captureRawToken(user.id);
    await confirmEmailVerification(rawToken);

    await requestEmailVerification(user.id); // should not throw, should not create a new token
    const db = createSystemClient();
    const remaining = await db.verificationToken.count({
      where: { identifier: `email-verify:${user.email}` },
    });
    expect(remaining).toBe(0);
  });
});
