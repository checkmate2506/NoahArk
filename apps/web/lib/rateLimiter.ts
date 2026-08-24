import { createHash } from "node:crypto";
import { getIdentityClient } from "@noahark/db";

/**
 * F-9 (Phase 1B.1): PostgreSQL-backed authentication rate limiter — replaces
 * the Phase 1B in-memory version, which did not work across multiple
 * application instances (a documented limitation at the time).
 *
 * Fixed-window counters, keyed on TWO independent dimensions per action
 * family (PASSWORD: EMAIL/IP; MFA: MFA_ACCOUNT/MFA_IP — see N-1, Phase 1D):
 *   - EMAIL / MFA_ACCOUNT: catches sustained brute-force against one
 *     account. The password dimension's threshold is kept at 10 (raised
 *     from the original 5 in Phase 1B) specifically so a single attacker
 *     cannot trivially lock a known victim out of their own account by
 *     deliberately failing their password a handful of times. The MFA
 *     dimension's threshold is much lower (5) — a 6-digit TOTP code paired
 *     with a ±1-step drift window is only 3-in-1,000,000 per attempt, so a
 *     brute-force attempt space that small justifies a tighter budget than
 *     password guessing does, and reaching this step already required
 *     knowing the correct password.
 *   - IP / MFA_IP: catches credential stuffing / broad brute-force from one
 *     source trying many different accounts. Only recorded when the
 *     caller's IP was extracted through a TRUSTED proxy hop count (see
 *     `extractClientIp` below) — an untrusted/unconfigured deployment
 *     simply does not get IP-dimension protection rather than trusting a
 *     spoofable header.
 *
 * The MFA dimensions are DELIBERATELY separate buckets from the password
 * ones (never shared keys/counters) — see N-1's own doc comments below on
 * `isMfaRateLimited`/`recordMfaFailedAttempt` for why, and critically, the
 * MFA_ACCOUNT dimension is keyed by the resolved userId (known from the
 * challenge token), NOT by the challenge token itself — a fresh token
 * issued after re-submitting the correct password does not reset this
 * counter, since the limit follows the ACCOUNT, not the token.
 *
 * A request is blocked if EITHER dimension (of the relevant pair) is at or
 * over its threshold.
 *
 * Concurrency safety: `recordFailedAttempt` uses a single
 * `INSERT ... ON CONFLICT (dimension, key_hash, window_start) DO UPDATE SET
 * attempt_count = attempt_count + 1` — an atomic, race-free increment at
 * the database level (not a read-then-write), so concurrent requests from
 * multiple application instances against the same window never lose an
 * increment. `windowStart` is the window's own boundary
 * (floor(now / WINDOW_MS) * WINDOW_MS), which is how counters expire
 * automatically without a separate decrement/reset step — a new window
 * simply gets a new row; `cleanupExpiredBuckets` removes old rows
 * opportunistically (see below) so the table does not grow unboundedly.
 *
 * Fail-secure without a global outage: if the database operation itself
 * fails (connection error, etc.), `isRateLimited` and `recordFailedAttempt`
 * catch the error, log it, and behave as "not limited" / "no-op" rather
 * than propagating — a rate-limiter infrastructure failure must not become
 * "nobody can sign in," which would itself be a trivial denial-of-service
 * vector (an attacker who can degrade the rate-limiter's own database
 * connectivity should not thereby lock out every legitimate user).
 */

const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS_PER_EMAIL = 10;
const MAX_ATTEMPTS_PER_IP = 20;
/** N-1 (Phase 1D): deliberately tighter than the password thresholds — see
 * the module doc comment above for the rationale (small guess space,
 * already-authenticated-by-password prerequisite). */
const MAX_ATTEMPTS_PER_MFA_ACCOUNT = 5;
const MAX_ATTEMPTS_PER_MFA_IP = 15;
/** How long a window's row is kept after it closes, purely for
 * observability/debugging — cleanup does not need to run promptly for
 * correctness (a closed window's row is never matched by a live check
 * again once `windowStart` has moved on). N-5 (Phase 1D): this is also the
 * retention window the scheduled maintenance sweep uses — see
 * packages/jobs/src/maintenance.ts. */
const RETENTION_MS = 24 * 60 * 60_000;

type RateLimitDimension = "EMAIL" | "IP" | "MFA_ACCOUNT" | "MFA_IP";

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Best-effort IPv4/IPv6 normalisation so the same real address always
 * hashes to the same key regardless of representation: lowercases,
 * strips an IPv6 zone index (`%eth0`), and collapses an IPv4-mapped IPv6
 * address (`::ffff:1.2.3.4`) to its IPv4 form. */
function normalizeIp(ip: string): string {
  let value = ip.trim().toLowerCase();
  const zoneIndex = value.indexOf("%");
  if (zoneIndex !== -1) value = value.slice(0, zoneIndex);
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value);
  if (mapped?.[1]) value = mapped[1];
  return value;
}

function currentWindowStart(now: number): Date {
  return new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS);
}

/**
 * F-9: trusted-proxy-aware client IP extraction. `X-Forwarded-For` is
 * attacker-controlled input from the raw TCP client unless a trusted
 * reverse proxy overwrites/appends to it — the standard "trusted hop
 * count" algorithm (same approach as Express's `trust proxy` / the
 * `proxy-addr` package) is: each trusted proxy appends the address it saw
 * to the header, so the genuine client address is exactly
 * `trustedProxyCount` entries from the RIGHT end of the comma-separated
 * list. With `trustedProxyCount = 0` (the safe default — no proxy is
 * configured/trusted), this returns `null` rather than trusting any part
 * of the header, and the IP dimension is simply skipped for that request
 * (email-dimension limiting still applies). Operators deploying behind a
 * reverse proxy/load balancer MUST set `TRUSTED_PROXY_COUNT` to the exact
 * number of trusted hops in front of the app — see `.env.example`.
 */
export function extractClientIp(req: Request, trustedProxyCount: number): string | null {
  if (trustedProxyCount <= 0) return null;
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return null;
  const hops = xff
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const index = hops.length - trustedProxyCount;
  if (index < 0 || index >= hops.length) return null;
  const candidate = hops[index];
  return candidate ? normalizeIp(candidate) : null;
}

function trustedProxyCountFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRUSTED_PROXY_COUNT;
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

async function checkDimension(
  dimension: RateLimitDimension,
  rawKey: string,
  max: number,
  now: number,
): Promise<boolean> {
  const db = getIdentityClient();
  const bucket = await db.authRateLimitBucket.findUnique({
    where: {
      dimension_keyHash_windowStart: {
        dimension,
        keyHash: hashKey(rawKey),
        windowStart: currentWindowStart(now),
      },
    },
    select: { attemptCount: true },
  });
  return (bucket?.attemptCount ?? 0) >= max;
}

/** `ipKey` is the ALREADY-normalized IP (or null, meaning "not trusted for
 * this request" — see `extractClientIp`). Fails OPEN (not limited) on a
 * database error — see the module doc comment for why. */
export async function isRateLimited(
  email: string,
  ipKey: string | null,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const emailLimited = await checkDimension(
      "EMAIL",
      normalizeEmail(email),
      MAX_ATTEMPTS_PER_EMAIL,
      now,
    );
    if (emailLimited) return true;
    if (ipKey) {
      const ipLimited = await checkDimension("IP", ipKey, MAX_ATTEMPTS_PER_IP, now);
      if (ipLimited) return true;
    }
    return false;
  } catch (e) {
    console.error(
      "[rateLimiter] isRateLimited check failed — failing OPEN (not limited)",
      e,
    );
    return false;
  }
}

async function incrementDimension(
  dimension: RateLimitDimension,
  rawKey: string,
  now: number,
): Promise<void> {
  const db = getIdentityClient();
  const windowStart = currentWindowStart(now);
  const keyHash = hashKey(rawKey);
  // Atomic upsert-with-increment — a single statement, race-free under
  // concurrent callers targeting the same (dimension, keyHash, windowStart).
  await db.$executeRaw`
    INSERT INTO "auth_rate_limit_bucket" ("id", "dimension", "key_hash", "window_start", "attempt_count", "updated_at")
    VALUES (gen_random_uuid()::text, ${dimension}::"RateLimitDimension", ${keyHash}, ${windowStart}, 1, now())
    ON CONFLICT ("dimension", "key_hash", "window_start")
    DO UPDATE SET "attempt_count" = "auth_rate_limit_bucket"."attempt_count" + 1, "updated_at" = now()
  `;
}

/** Fails OPEN (silently does not record) on a database error — see the
 * module doc comment. A failure here degrades rate-limiting protection
 * for this one attempt; it must never block the sign-in flow itself. */
export async function recordFailedAttempt(
  email: string,
  ipKey: string | null,
  now: number = Date.now(),
): Promise<void> {
  try {
    await incrementDimension("EMAIL", normalizeEmail(email), now);
    if (ipKey) await incrementDimension("IP", ipKey, now);
  } catch (e) {
    console.error(
      "[rateLimiter] recordFailedAttempt failed — continuing without recording",
      e,
    );
  }
}

/**
 * F-9: deliberately does NOT delete the current window's EMAIL counter on
 * a successful sign-in (unlike the Phase 1B in-memory version) — a fixed
 * window that simply expires is easier to reason about than a
 * reset-on-success policy, which can itself become a vector (repeatedly
 * alternate a wrong guess with a distinct successful sign-in on a DIFFERENT
 * account to keep resetting an unrelated counter has no effect here,
 * since each account's counter is independent — but reset-on-success for
 * the SAME account would let an attacker who eventually guesses correctly
 * erase their own attempt history, which is not a property worth
 * preserving). The window simply lapses after `WINDOW_MS`. This function
 * is kept as a no-op-with-documented-rationale rather than removed, so a
 * future caller reading the sign-in route doesn't have to rediscover this
 * decision.
 */
export function clearAttempts(_email: string): void {
  // Deliberate no-op — see doc comment above.
}

/**
 * N-1 (Phase 1D): MFA-challenge rate limiting, deliberately separate from
 * `isRateLimited`/`recordFailedAttempt`/`clearAttempts` above (distinct
 * dimensions, distinct thresholds, distinct reset policy — see the module
 * doc comment). `userId` is `null` when the caller has not yet resolved a
 * challenge token to a user (e.g. the token itself is garbage/unknown) —
 * in that case only the IP dimension is checked, which is still real
 * protection against a completely blind flood of challenge attempts.
 * Fails OPEN on a database error, matching the password limiter's
 * documented availability policy — see the module doc comment.
 */
export async function isMfaRateLimited(
  userId: string | null,
  ipKey: string | null,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    if (userId) {
      const accountLimited = await checkDimension(
        "MFA_ACCOUNT",
        userId,
        MAX_ATTEMPTS_PER_MFA_ACCOUNT,
        now,
      );
      if (accountLimited) return true;
    }
    if (ipKey) {
      const ipLimited = await checkDimension(
        "MFA_IP",
        ipKey,
        MAX_ATTEMPTS_PER_MFA_IP,
        now,
      );
      if (ipLimited) return true;
    }
    return false;
  } catch (e) {
    console.error(
      "[rateLimiter] isMfaRateLimited check failed — failing OPEN (not limited)",
      e,
    );
    return false;
  }
}

/** Fails OPEN (silently does not record) on a database error — same
 * availability policy as `recordFailedAttempt`. Called for EVERY failed
 * MFA challenge outcome (wrong TOTP, wrong/reused recovery code, a replayed
 * TOTP counter, or an expired/unresolvable challenge token where `userId`
 * is null) — see mfaService.ts's `verifyMfaChallenge`. */
export async function recordMfaFailedAttempt(
  userId: string | null,
  ipKey: string | null,
  now: number = Date.now(),
): Promise<void> {
  try {
    if (userId) await incrementDimension("MFA_ACCOUNT", userId, now);
    if (ipKey) await incrementDimension("MFA_IP", ipKey, now);
  } catch (e) {
    console.error(
      "[rateLimiter] recordMfaFailedAttempt failed — continuing without recording",
      e,
    );
  }
}

/**
 * N-1 (Phase 1D): UNLIKE `clearAttempts` (password dimension — a
 * deliberate no-op, see its own doc comment), this is a REAL reset. The
 * password-dimension reasoning ("an attacker who eventually guesses
 * correctly could erase their own attempt history") does not transfer
 * here: reaching a successful MFA verification already required knowing
 * the correct password AND the correct current TOTP/recovery code — an
 * attacker capable of "eventually succeeding" at MFA has, by definition,
 * already fully authenticated, so resetting their own counter afterwards
 * grants nothing further. What resetting DOES buy is avoiding real,
 * legitimate lockout friction: TOTP has a materially higher genuine
 * false-failure rate than password entry (typos, clock drift, fumbling
 * between an authenticator app and the browser), so a real user who
 * fails 2-3 times before succeeding — an ordinary, expected occurrence —
 * should not carry that count forward into their NEXT sign-in attempt
 * hours later. Only clears the MFA_ACCOUNT dimension (the per-user one);
 * the MFA_IP dimension is intentionally left alone, since a shared IP's
 * budget is about that IP's aggregate behaviour across every account,
 * which one account's successful sign-in says nothing about. Fails
 * OPEN/silently on a database error — a cleanup failure must not block
 * the sign-in response.
 */
export async function clearMfaAttempts(
  userId: string,
  now: number = Date.now(),
): Promise<void> {
  try {
    const db = getIdentityClient();
    await db.authRateLimitBucket.deleteMany({
      where: {
        dimension: "MFA_ACCOUNT",
        keyHash: hashKey(userId),
        windowStart: currentWindowStart(now),
      },
    });
  } catch (e) {
    console.error("[rateLimiter] clearMfaAttempts failed — continuing", e);
  }
}

/** Deletes bucket rows whose window closed more than RETENTION_MS ago.
 * Safe to run opportunistically or manually; not required for correctness,
 * only for keeping the table small. N-5 (Phase 1D): now wired into the
 * worker's periodic maintenance sweep — see packages/jobs/src/maintenance.ts
 * — in addition to remaining an explicit, directly callable primitive
 * (used by this file's own tests, and safe to invoke manually/from an
 * administrative script). */
export async function cleanupExpiredBuckets(now: number = Date.now()): Promise<number> {
  const db = getIdentityClient();
  const cutoff = new Date(now - RETENTION_MS);
  const result = await db.authRateLimitBucket.deleteMany({
    where: { windowStart: { lt: cutoff } },
  });
  return result.count;
}

export {
  trustedProxyCountFromEnv,
  normalizeIp,
  normalizeEmail,
  hashKey,
  WINDOW_MS,
  MAX_ATTEMPTS_PER_EMAIL,
  MAX_ATTEMPTS_PER_IP,
  MAX_ATTEMPTS_PER_MFA_ACCOUNT,
  MAX_ATTEMPTS_PER_MFA_IP,
  RETENTION_MS,
};
