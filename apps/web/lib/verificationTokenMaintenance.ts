import { getIdentityClient } from "@noahark/db";

/**
 * N-5 (Phase 1D): `VerificationToken` (email verification —
 * emailVerificationService.ts — and MFA challenge tokens — mfaService.ts —
 * share this one table) is single-use and deleted on successful
 * consumption, but a token that is never consumed at all — an email link
 * never clicked, an MFA challenge abandoned mid-sign-in — has no other
 * path to deletion and would otherwise accumulate forever. Generic across
 * both token kinds: deletes purely on the row's own `expires` timestamp,
 * with no need to know either service's identifier-prefix convention.
 * Wired into the worker's periodic maintenance sweep — see
 * apps/web/scripts/worker.ts and packages/jobs/src/maintenance.ts.
 */
export async function cleanupExpiredVerificationTokens(
  now: number = Date.now(),
): Promise<number> {
  const db = getIdentityClient();
  const result = await db.verificationToken.deleteMany({
    where: { expires: { lt: new Date(now) } },
  });
  return result.count;
}
