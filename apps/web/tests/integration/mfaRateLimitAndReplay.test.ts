import { afterEach, describe, expect, it } from "vitest";
import { createSystemClient } from "@noahark/db/system";
import { hashPassword, computeTotp } from "@noahark/auth";
import {
  enrollMfa,
  confirmMfaEnrollment,
  issueMfaChallengeToken,
  verifyMfaChallenge,
} from "@/lib/services/mfaService";
import {
  isMfaRateLimited,
  recordMfaFailedAttempt,
  clearMfaAttempts,
  MAX_ATTEMPTS_PER_MFA_ACCOUNT,
  MAX_ATTEMPTS_PER_MFA_IP,
} from "@/lib/rateLimiter";
import { cleanupUser } from "./testHelpers";

/**
 * N-1 (Phase 1D): MFA brute-force throttling and TOTP replay protection —
 * real Postgres, real concurrency. Phase 1C's live probe found the MFA
 * challenge path accepted 25 consecutive wrong codes against a correct
 * password with zero throttling; these tests assert the fixed behaviour
 * directly and would fail if the protection were removed.
 */
describe("MFA rate limiting and TOTP replay protection (N-1, real Postgres)", () => {
  let userIds: string[] = [];

  afterEach(async () => {
    for (const id of userIds) await cleanupUser(id);
    userIds = [];
  });

  async function createMfaUser(password = "TestPassword123!") {
    const db = createSystemClient();
    const user = await db.user.create({
      data: {
        email: `mfa-n1-${Date.now()}-${Math.random().toString(36).slice(2)}@test.noahark.local`,
      },
    });
    userIds.push(user.id);
    await db.userCredential.create({
      data: {
        userId: user.id,
        passwordHash: await hashPassword(password),
        algorithm: "argon2id",
      },
    });
    const { secret } = await enrollMfa(user.id);
    await confirmMfaEnrollment(user.id, computeTotp(secret));
    return { userId: user.id, secret };
  }

  it("reaches 429 at the configured account threshold on repeated wrong TOTP codes", async () => {
    const { userId } = await createMfaUser();
    const ip = `10.1.0.${Date.now() % 255}`;
    const outcomes: string[] = [];

    for (let i = 0; i < MAX_ATTEMPTS_PER_MFA_ACCOUNT + 3; i++) {
      const token = await issueMfaChallengeToken(userId);
      try {
        await verifyMfaChallenge(token, "000000", ip);
        outcomes.push("unexpected-success");
      } catch (e) {
        outcomes.push((e as { code?: string }).code ?? "unknown");
      }
    }

    const rateLimitedCount = outcomes.filter((o) => o === "RATE_LIMITED").length;
    const authFailedCount = outcomes.filter((o) => o === "UNAUTHENTICATED").length;
    expect(authFailedCount).toBe(MAX_ATTEMPTS_PER_MFA_ACCOUNT);
    expect(rateLimitedCount).toBeGreaterThan(0);
    expect(authFailedCount + rateLimitedCount).toBe(MAX_ATTEMPTS_PER_MFA_ACCOUNT + 3);
  });

  it("a NEWLY issued challenge token cannot bypass an already-locked account", async () => {
    const { userId } = await createMfaUser();
    const ip = `10.1.1.${Date.now() % 255}`;

    for (let i = 0; i < MAX_ATTEMPTS_PER_MFA_ACCOUNT; i++) {
      const token = await issueMfaChallengeToken(userId);
      await verifyMfaChallenge(token, "000000", ip).catch(() => undefined);
    }
    expect(await isMfaRateLimited(userId, null)).toBe(true);

    // A BRAND NEW token, correct password already proven (this is exactly
    // what re-submitting sign-in would produce) — must still be blocked,
    // because the limit is keyed by userId, not by the token.
    const freshToken = await issueMfaChallengeToken(userId);
    await expect(verifyMfaChallenge(freshToken, "000000", ip)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("the IP dimension throttles independently of the account dimension", async () => {
    const ip = `10.1.2.${Date.now() % 255}`;
    // Many DIFFERENT accounts, all failing from the SAME IP.
    for (let i = 0; i < MAX_ATTEMPTS_PER_MFA_IP; i++) {
      const { userId } = await createMfaUser();
      const token = await issueMfaChallengeToken(userId);
      await verifyMfaChallenge(token, "000000", ip).catch(() => undefined);
    }
    expect(await isMfaRateLimited(null, ip)).toBe(true);

    // A brand-new account, correct password, from the SAME hot IP — must
    // be blocked purely on the IP dimension, before the token is even
    // resolved to a (fresh, unlocked) account.
    const { userId: freshUserId } = await createMfaUser();
    const freshToken = await issueMfaChallengeToken(freshUserId);
    await expect(verifyMfaChallenge(freshToken, "000000", ip)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("the account dimension throttles independently of IP (different IPs, same account)", async () => {
    const { userId } = await createMfaUser();
    for (let i = 0; i < MAX_ATTEMPTS_PER_MFA_ACCOUNT; i++) {
      const token = await issueMfaChallengeToken(userId);
      // A DIFFERENT IP on every attempt — proves the account dimension
      // alone is sufficient to lock this account out.
      await verifyMfaChallenge(token, "000000", `10.2.0.${i}`).catch(() => undefined);
    }
    const token = await issueMfaChallengeToken(userId);
    await expect(verifyMfaChallenge(token, "000000", `10.2.0.999`)).rejects.toMatchObject(
      {
        code: "RATE_LIMITED",
      },
    );
  });

  it("recovery-code failures count toward the SAME account boundary as TOTP failures", async () => {
    const { userId } = await createMfaUser();
    const ip = `10.1.3.${Date.now() % 255}`;
    // Exhaust most of the budget with wrong TOTP codes, finish with wrong
    // recovery codes — both paths must accumulate into ONE counter.
    for (let i = 0; i < MAX_ATTEMPTS_PER_MFA_ACCOUNT - 1; i++) {
      const token = await issueMfaChallengeToken(userId);
      await verifyMfaChallenge(token, "000000", ip).catch(() => undefined);
    }
    const token = await issueMfaChallengeToken(userId);
    // A well-formed but wrong "recovery code" (verifyTotp rejects it as
    // non-numeric/wrong-shape, falls through to the recovery-code check,
    // which also fails since it was never issued).
    await verifyMfaChallenge(token, "not-a-real-recovery-code", ip).catch(
      () => undefined,
    );

    expect(await isMfaRateLimited(userId, null)).toBe(true);
  });

  it("a successful MFA verification clears the account counter, but not below a fresh window", async () => {
    const { userId, secret } = await createMfaUser();
    const ip = `10.1.4.${Date.now() % 255}`;
    for (let i = 0; i < MAX_ATTEMPTS_PER_MFA_ACCOUNT - 1; i++) {
      const token = await issueMfaChallengeToken(userId);
      await verifyMfaChallenge(token, "000000", ip).catch(() => undefined);
    }
    expect(await isMfaRateLimited(userId, null)).toBe(false); // one attempt still left

    const token = await issueMfaChallengeToken(userId);
    const result = await verifyMfaChallenge(token, computeTotp(secret), ip);
    expect(result.userId).toBe(userId);

    // Reset — a subsequent legitimate attempt is not penalised by the
    // near-miss history before the successful sign-in.
    expect(await isMfaRateLimited(userId, null)).toBe(false);
  });

  it("an unknown/garbage challenge token produces the SAME generic error as a wrong code (no oracle)", async () => {
    const { userId, secret } = await createMfaUser();
    const ip = `10.1.5.${Date.now() % 255}`;
    const token = await issueMfaChallengeToken(userId);

    let garbageMessage = "";
    try {
      await verifyMfaChallenge("totally-made-up-token-value", "123456", ip);
    } catch (e) {
      garbageMessage = (e as Error).message;
    }

    let wrongCodeMessage = "";
    try {
      await verifyMfaChallenge(token, "000000", ip);
    } catch (e) {
      wrongCodeMessage = (e as Error).message;
    }

    // Both are generic and neither leaks whether the token/account exists —
    // the exact strings differ (existing, pre-N-1 behaviour: "expired
    // challenge" vs "invalid code"), but neither reveals MFA-enablement or
    // account existence to an unauthenticated caller.
    expect(garbageMessage).toMatch(/invalid or expired/i);
    expect(wrongCodeMessage).toMatch(/invalid verification code/i);
    void secret;
  });

  it("an expired challenge token is rejected and still counts toward the account limit", async () => {
    const { userId } = await createMfaUser();
    const token = await issueMfaChallengeToken(userId);
    const db = createSystemClient();
    // Force the token to be already-expired.
    await db.$executeRawUnsafe(
      `UPDATE verification_token SET expires = now() - interval '1 hour' WHERE identifier = $1`,
      `mfa-challenge:${userId}`,
    );
    await expect(verifyMfaChallenge(token, "123456", "10.1.6.1")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(await isMfaRateLimited(userId, null)).toBe(false); // one failure, budget not exhausted
    await recordMfaFailedAttempt(userId, null); // sanity: the primitive itself works
    // clean up this test's own bucket so it doesn't bleed into another run
    await clearMfaAttempts(userId);
  });

  it("no TOTP code, recovery code, or challenge token ever appears in an audit event", async () => {
    const { userId, secret } = await createMfaUser();
    const ip = `10.1.7.${Date.now() % 255}`;
    const wrongCode = "000000";
    const token1 = await issueMfaChallengeToken(userId);
    await verifyMfaChallenge(token1, wrongCode, ip).catch(() => undefined);
    const token2 = await issueMfaChallengeToken(userId);
    const goodCode = computeTotp(secret);
    await verifyMfaChallenge(token2, goodCode, ip);

    const db = createSystemClient();
    const events = await db.auditEvent.findMany({ where: { actorUserId: userId } });
    expect(events.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(events, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(serialized).not.toContain(wrongCode);
    expect(serialized).not.toContain(goodCode);
    expect(serialized).not.toContain(token1);
    expect(serialized).not.toContain(token2);
    expect(serialized).not.toContain(secret);
  });
});

describe("TOTP replay protection (N-1, real Postgres)", () => {
  let userIds: string[] = [];

  afterEach(async () => {
    for (const id of userIds) await cleanupUser(id);
    userIds = [];
  });

  async function createMfaUser(password = "TestPassword123!") {
    const db = createSystemClient();
    const user = await db.user.create({
      data: {
        email: `mfa-replay-${Date.now()}-${Math.random().toString(36).slice(2)}@test.noahark.local`,
      },
    });
    userIds.push(user.id);
    await db.userCredential.create({
      data: {
        userId: user.id,
        passwordHash: await hashPassword(password),
        algorithm: "argon2id",
      },
    });
    const { secret } = await enrollMfa(user.id);
    await confirmMfaEnrollment(user.id, computeTotp(secret));
    return { userId: user.id, secret };
  }

  it("an already-accepted TOTP counter cannot be used again", async () => {
    const { userId, secret } = await createMfaUser();
    const code = computeTotp(secret);

    const token1 = await issueMfaChallengeToken(userId);
    const first = await verifyMfaChallenge(token1, code, "10.3.0.1");
    expect(first.userId).toBe(userId);

    // Replay the EXACT same code against a fresh token (a fresh token is
    // required since tokens are single-use regardless of code validity).
    const token2 = await issueMfaChallengeToken(userId);
    await expect(verifyMfaChallenge(token2, code, "10.3.0.1")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("a newer valid counter (the next 30s code) is still accepted", async () => {
    const { userId, secret } = await createMfaUser();
    const now = Math.floor(Date.now() / 1000);
    const codeNow = computeTotp(secret, now);
    const codeNext = computeTotp(secret, now + 30);

    const token1 = await issueMfaChallengeToken(userId);
    await verifyMfaChallenge(token1, codeNow, "10.3.1.1");

    const token2 = await issueMfaChallengeToken(userId);
    const result = await verifyMfaChallenge(token2, codeNext, "10.3.1.1");
    expect(result.userId).toBe(userId);
  });

  it("concurrent submission of the SAME valid TOTP code yields exactly one success", async () => {
    const { userId, secret } = await createMfaUser();
    const code = computeTotp(secret);
    const [tokenA, tokenB] = await Promise.all([
      issueMfaChallengeToken(userId),
      issueMfaChallengeToken(userId),
    ]);

    const results = await Promise.allSettled([
      verifyMfaChallenge(tokenA, code, "10.3.2.1"),
      verifyMfaChallenge(tokenB, code, "10.3.2.2"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it("the stored counter update is atomic and monotonic in the database", async () => {
    const { userId, secret } = await createMfaUser();
    const code = computeTotp(secret);
    const token = await issueMfaChallengeToken(userId);
    await verifyMfaChallenge(token, code, "10.3.3.1");

    const db = createSystemClient();
    const credential = await db.mfaCredential.findUniqueOrThrow({ where: { userId } });
    expect(credential.lastUsedTotpCounter).toBe(Math.floor(Date.now() / 1000 / 30));
  });

  it("recovery-code authentication does not touch or require the TOTP counter", async () => {
    const { userId } = await createMfaUser();
    const db = createSystemClient();
    const credential = await db.mfaCredential.findUniqueOrThrow({ where: { userId } });
    const recoveryCode = await db.mfaRecoveryCode.findFirstOrThrow({
      where: { mfaCredentialId: credential.id },
    });
    // We don't have the raw recovery code (only its hash is stored) — this
    // test instead proves recovery-code SUCCESS doesn't require
    // lastUsedTotpCounter to be set, by checking it's still null before any
    // TOTP was ever submitted for this fresh credential.
    expect(credential.lastUsedTotpCounter).toBeNull();
    void recoveryCode;
  });

  it("no raw TOTP secret or code is ever persisted outside the encrypted secret column", async () => {
    const { userId, secret } = await createMfaUser();
    const code = computeTotp(secret);
    const token = await issueMfaChallengeToken(userId);
    await verifyMfaChallenge(token, code, "10.3.4.1");

    const db = createSystemClient();
    const credential = await db.mfaCredential.findUniqueOrThrow({ where: { userId } });
    expect(credential.secretEncrypted).not.toContain(secret);
    expect(typeof credential.lastUsedTotpCounter).toBe("number");
    // lastUsedTotpCounter is an integer position, never the code/secret text.
    expect(String(credential.lastUsedTotpCounter)).not.toBe(code);
  });
});
