import { afterEach, describe, expect, it } from "vitest";
import { createSystemClient } from "@noahark/db/system";
import { hashPassword, computeTotp } from "@noahark/auth";
import {
  enrollMfa,
  confirmMfaEnrollment,
  disableMfa,
  hasMfaEnabled,
  issueMfaChallengeToken,
  verifyMfaChallenge,
} from "@/lib/services/mfaService";
import { cleanupUser } from "./testHelpers";

describe("TOTP MFA (F-3B, real Postgres)", () => {
  let userIds: string[] = [];

  afterEach(async () => {
    for (const id of userIds) await cleanupUser(id);
    userIds = [];
  });

  async function createUserWithPassword(password = "TestPassword123!"): Promise<string> {
    const db = createSystemClient();
    const user = await db.user.create({
      data: { email: `mfa-${Date.now()}-${Math.random()}@test.noahark.local` },
    });
    await db.userCredential.create({
      data: {
        userId: user.id,
        passwordHash: await hashPassword(password),
        algorithm: "argon2id",
      },
    });
    userIds.push(user.id);
    return user.id;
  }

  it("is disabled by default for a new user", async () => {
    const userId = await createUserWithPassword();
    expect(await hasMfaEnabled(userId)).toBe(false);
  });

  it("does not enable MFA until enrolment is confirmed with a valid code", async () => {
    const userId = await createUserWithPassword();
    const { secret } = await enrollMfa(userId);
    expect(secret).toBeTruthy();
    expect(await hasMfaEnabled(userId)).toBe(false); // unconfirmed — must not gate sign-in yet
  });

  it("enrols, confirms, and completes a full challenge cycle", async () => {
    const userId = await createUserWithPassword();
    const { secret } = await enrollMfa(userId);

    const code = computeTotp(secret);
    const { recoveryCodes } = await confirmMfaEnrollment(userId, code);
    expect(recoveryCodes).toHaveLength(10);
    expect(await hasMfaEnabled(userId)).toBe(true);

    const challengeToken = await issueMfaChallengeToken(userId);
    const nextCode = computeTotp(secret);
    const result = await verifyMfaChallenge(challengeToken, nextCode);
    expect(result.userId).toBe(userId);
  });

  it("rejects confirmation with an invalid code", async () => {
    const userId = await createUserWithPassword();
    await enrollMfa(userId);
    await expect(confirmMfaEnrollment(userId, "000000")).rejects.toThrow(
      /invalid verification code/i,
    );
  });

  it("rejects a challenge with an incorrect code", async () => {
    const userId = await createUserWithPassword();
    const { secret } = await enrollMfa(userId);
    await confirmMfaEnrollment(userId, computeTotp(secret));

    const challengeToken = await issueMfaChallengeToken(userId);
    await expect(verifyMfaChallenge(challengeToken, "000000")).rejects.toThrow(
      /invalid verification code/i,
    );
  });

  it("consumes the challenge token even on failure (no unlimited retries against one password proof)", async () => {
    const userId = await createUserWithPassword();
    const { secret } = await enrollMfa(userId);
    await confirmMfaEnrollment(userId, computeTotp(secret));

    const challengeToken = await issueMfaChallengeToken(userId);
    await expect(verifyMfaChallenge(challengeToken, "000000")).rejects.toThrow();
    // Same token, now correct code — must still fail, since it was consumed.
    await expect(verifyMfaChallenge(challengeToken, computeTotp(secret))).rejects.toThrow(
      /invalid or expired/i,
    );
  });

  it("accepts a valid recovery code exactly once", async () => {
    const userId = await createUserWithPassword();
    const { secret } = await enrollMfa(userId);
    const { recoveryCodes } = await confirmMfaEnrollment(userId, computeTotp(secret));
    const code = recoveryCodes[0]!;

    const token1 = await issueMfaChallengeToken(userId);
    const result = await verifyMfaChallenge(token1, code);
    expect(result.userId).toBe(userId);

    const token2 = await issueMfaChallengeToken(userId);
    await expect(verifyMfaChallenge(token2, code)).rejects.toThrow(
      /invalid verification code/i,
    );
  });

  it("rejects a recovery code belonging to a DIFFERENT user's MFA credential", async () => {
    const userA = await createUserWithPassword();
    const { secret: secretA } = await enrollMfa(userA);
    await confirmMfaEnrollment(userA, computeTotp(secretA));

    const userB = await createUserWithPassword();
    const { secret: secretB } = await enrollMfa(userB);
    const { recoveryCodes: codesB } = await confirmMfaEnrollment(
      userB,
      computeTotp(secretB),
    );

    // Challenge for user A, using user B's recovery code.
    const token = await issueMfaChallengeToken(userA);
    await expect(verifyMfaChallenge(token, codesB[0]!)).rejects.toThrow(
      /invalid verification code/i,
    );
  });

  it("disable requires the correct current password", async () => {
    const userId = await createUserWithPassword("CorrectPassword123!");
    const { secret } = await enrollMfa(userId);
    await confirmMfaEnrollment(userId, computeTotp(secret));

    await expect(disableMfa(userId, "WrongPassword!")).rejects.toThrow(
      /incorrect password/i,
    );
    expect(await hasMfaEnabled(userId)).toBe(true); // unchanged

    await disableMfa(userId, "CorrectPassword123!");
    expect(await hasMfaEnabled(userId)).toBe(false);
  });

  it("disabling and re-enrolling replaces the secret and recovery codes entirely", async () => {
    const userId = await createUserWithPassword("Password123!");
    const { secret: firstSecret } = await enrollMfa(userId);
    await confirmMfaEnrollment(userId, computeTotp(firstSecret));
    await disableMfa(userId, "Password123!");

    const { secret: secondSecret } = await enrollMfa(userId);
    expect(secondSecret).not.toBe(firstSecret);
    await confirmMfaEnrollment(userId, computeTotp(secondSecret));

    // The OLD secret must no longer work.
    const token = await issueMfaChallengeToken(userId);
    await expect(verifyMfaChallenge(token, computeTotp(firstSecret))).rejects.toThrow();
  });

  it("never writes the TOTP secret or a recovery code into any audit event (F-3B security)", async () => {
    const userId = await createUserWithPassword();
    const { secret } = await enrollMfa(userId);
    const { recoveryCodes } = await confirmMfaEnrollment(userId, computeTotp(secret));
    const token = await issueMfaChallengeToken(userId);
    await verifyMfaChallenge(token, recoveryCodes[0]!);

    const db = createSystemClient();
    const events = await db.auditEvent.findMany({ where: { actorUserId: userId } });
    expect(events.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(events, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(serialized).not.toContain(secret);
    for (const code of recoveryCodes) {
      expect(serialized).not.toContain(code);
    }
  });
});
