import {
  type MaintenanceTask,
  cleanupTerminalJobs,
  cleanupTerminalOutboxEvents,
} from "@noahark/jobs";
import { cleanupExpiredBuckets } from "@/lib/rateLimiter";
import { cleanupExpiredVerificationTokens } from "@/lib/verificationTokenMaintenance";
import {
  cleanupExpiredSessions,
  cleanupTerminalInvitations,
  cleanupExpiredTestEmailCaptures,
  purgeDeletedFileObjectStorage,
} from "@/lib/retentionMaintenance";

/**
 * P1E-4 (Phase 1F): the single source of truth for what the worker's
 * periodic maintenance sweep actually runs — shared between
 * `apps/web/scripts/worker.ts` (which passes this to `startWorkerLoop`)
 * and `apps/web/lib/maintenanceRegistry.test.ts` (P1G-5, Phase 1H:
 * corrected from a previously-wrong path,
 * `apps/web/tests/integration/maintenanceInventory.test.ts`, which was
 * never the actual file — this test asserts every documented retention
 * category maps to a key here). Adding
 * a new retention routine without registering it here is now a failing
 * test, not a silent gap — exactly what Phase 1E's N-5 finding described.
 *
 * `expiredVerificationAndMfaChallengeTokens` covers TWO of the documented
 * categories (email-verification tokens and MFA challenge tokens) with a
 * single task — both live in the same `verification_token` table by
 * design (see mfaService.ts/emailVerificationService.ts), so a single
 * `expires`-based sweep already covers both; registering two separate
 * tasks that do the identical work would just mean the second one always
 * finds zero rows.
 */
export const MAINTENANCE_TASKS: Readonly<Record<string, MaintenanceTask>> = {
  expiredRateLimitBuckets: cleanupExpiredBuckets,
  expiredVerificationAndMfaChallengeTokens: cleanupExpiredVerificationTokens,
  expiredSessions: cleanupExpiredSessions,
  terminalMembershipInvitations: cleanupTerminalInvitations,
  expiredTestEmailCaptures: cleanupExpiredTestEmailCaptures,
  terminalBackgroundJobs: cleanupTerminalJobs,
  terminalOutboxEvents: cleanupTerminalOutboxEvents,
  deletedFileObjectStorage: purgeDeletedFileObjectStorage,
};

/** Every documented retention category (Phase 1F, P1E-4) mapped to the
 * registry key that covers it — the inventory test iterates this, not the
 * registry's own keys, so a category can never be silently dropped by
 * simply renaming/removing a key without anyone noticing. */
export const DOCUMENTED_MAINTENANCE_CATEGORIES: Readonly<
  Record<string, keyof typeof MAINTENANCE_TASKS>
> = {
  "expired rate-limit buckets": "expiredRateLimitBuckets",
  "expired email-verification tokens": "expiredVerificationAndMfaChallengeTokens",
  "expired MFA challenges": "expiredVerificationAndMfaChallengeTokens",
  "expired sessions": "expiredSessions",
  "expired/revoked/consumed membership invitations": "terminalMembershipInvitations",
  "expired test email captures": "expiredTestEmailCaptures",
  "terminal SUCCEEDED/DEAD background jobs": "terminalBackgroundJobs",
  "terminal PROCESSED/FAILED outbox events": "terminalOutboxEvents",
  // P1G-4 (Phase 1H): renamed from "deleted file objects' physical
  // storage" — this purges only the physical bytes behind a deleted file;
  // the file_object ROW is deliberately retained as a tombstone (see
  // retentionMaintenance.ts's purgeDeletedFileObjectStorage doc comment).
  // The old label read as if the whole record were being cleaned up.
  "Deleted-file physical storage purge": "deletedFileObjectStorage",
};
