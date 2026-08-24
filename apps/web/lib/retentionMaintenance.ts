import {
  getIdentityClient,
  withTenantContext,
  listAllTenantIdsForMaintenance,
} from "@noahark/db";
import { getStorageProvider } from "@/lib/services/fileServiceWrapper";

/**
 * P1E-4 (Phase 1F): the app-runtime-owned retention categories Phase 1E
 * found unregistered — expired sessions, terminal membership invitations,
 * expired test-email captures, and the physical storage objects behind
 * deleted files. (Terminal background jobs and outbox events live in
 * `packages/jobs` instead — `background_job`/`outbox_event` are
 * tenant-owned tables that need a genuine cross-tenant sweep, which only
 * `noahark_worker`'s RLS-scoped client can do without either an
 * unqualified query or per-tenant iteration; see queue.ts/outbox.ts's
 * `cleanupTerminalJobs`/`cleanupTerminalOutboxEvents` for why.)
 *
 * `membership_invitation` and `file_object` are ALSO tenant-owned, but
 * `noahark_worker` has no grant on either (deliberately — ADR-31 keeps its
 * footprint to exactly the two queue tables, not a blanket grant), so
 * these two sweep every tenant via `withTenantContext` — the same
 * RLS-safe, already-established pattern every other tenant-scoped
 * operation in this codebase uses — rather than widening what the worker
 * role can touch just for this.
 *
 * Each function takes a bounded batch per tenant per call (so one sweep
 * can never become an unbounded scan/lock) and is idempotent — safe to run
 * again on the next maintenance cycle if a previous run only got partway
 * or failed outright (see `runMaintenanceTasks`'s per-task isolation in
 * packages/jobs/src/maintenance.ts, which this integrates with).
 *
 * Every cutoff here is computed in application time (`Date.now()`), the
 * same convention already used by `rateLimiter.ts`'s and
 * `verificationTokenMaintenance.ts`'s retention sweeps — Phase 1 targets a
 * single application/worker deployment with no cross-instance clock-drift
 * concern, so a database-time cutoff (`now()` inside the query) would add
 * complexity without a corresponding correctness benefit here.
 *
 * Deliberately NOT touched by anything in this file: `audit_event` (never
 * deleted by anything but the disabled-trigger test-fixture path — see
 * testDataPurge.ts's own doc comment), active sessions/invitations/files
 * (every query below is scoped to a terminal state PAST its own retention
 * window), and any record whose legal/statutory retention obligation is
 * not yet defined (Phase 1 has none — see CLAUDE.md's
 * regulatory-implementation-rule; a future phase introducing statutory
 * retention requirements must review this file before reusing its
 * patterns for anything tax/payroll-adjacent).
 */
const MAINTENANCE_BATCH_SIZE = 500;

const SESSION_RETENTION_MS = 24 * 60 * 60 * 1000; // 1 day past expiry
const INVITATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days past terminal
const TEST_EMAIL_CAPTURE_RETENTION_MS = 24 * 60 * 60 * 1000; // 1 day
const DELETED_FILE_STORAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days past soft-delete

export {
  MAINTENANCE_BATCH_SIZE,
  SESSION_RETENTION_MS,
  INVITATION_RETENTION_MS,
  TEST_EMAIL_CAPTURE_RETENTION_MS,
  DELETED_FILE_STORAGE_RETENTION_MS,
};

/** Expired sessions — `resolveSession` (session.ts) already refuses an
 * expired session on every request and opportunistically deletes it on
 * that path, but a session nobody ever presents again (an abandoned
 * browser, a token that was never used past expiry) has no other path to
 * deletion. A day of slack past `expires` costs nothing and avoids racing
 * a session that just barely expired mid-request. `Session` is NOT
 * tenant-owned (it belongs to a User, not a Tenant), so this is a single
 * unscoped-but-safe sweep via the ordinary app client, same as the
 * rate-limit-bucket and verification-token sweeps. */
export async function cleanupExpiredSessions(now: number = Date.now()): Promise<number> {
  const db = getIdentityClient();
  const cutoff = new Date(now - SESSION_RETENTION_MS);
  const eligible = await db.session.findMany({
    where: { expires: { lt: cutoff } },
    select: { id: true },
    take: MAINTENANCE_BATCH_SIZE,
  });
  if (eligible.length === 0) return 0;
  const result = await db.session.deleteMany({
    where: { id: { in: eligible.map((s) => s.id) } },
  });
  return result.count;
}

/** Enumerates every tenant id via `listAllTenantIdsForMaintenance` (see
 * client.ts's own doc comment — a SECURITY DEFINER database function that
 * returns ONLY ids, database-enforced, not an application convention) and
 * runs `fn` once per tenant inside an ordinary `withTenantContext`, so the
 * actual per-tenant work is exactly as RLS-scoped as any other
 * tenant-owned-model operation in this codebase. */
async function forEachTenant<T>(fn: (tenantId: string) => Promise<T>): Promise<T[]> {
  const tenantIds = await listAllTenantIdsForMaintenance();
  const results: T[] = [];
  for (const tenantId of tenantIds) {
    results.push(await fn(tenantId));
  }
  return results;
}

/** Membership invitations that can no longer be acted on: ACCEPTED (past
 * `acceptedAt` + retention), REVOKED (past `revokedAt` + retention), or
 * PENDING/EXPIRED whose `expiresAt` is itself past retention. A merely
 * expired-but-still-PENDING invitation within the retention window is
 * preserved — an admin resending or investigating it shortly after expiry
 * is a real, expected workflow. Iterates every tenant via
 * `withTenantContext` (see this module's own doc comment for why). */
export async function cleanupTerminalInvitations(
  now: number = Date.now(),
): Promise<number> {
  const cutoff = new Date(now - INVITATION_RETENTION_MS);
  const perTenant = await forEachTenant((tenantId) =>
    withTenantContext({ tenantId, legalEntityIds: new Set<string>() }, async (tx) => {
      const eligible = await tx.membershipInvitation.findMany({
        where: {
          OR: [
            { status: "ACCEPTED", acceptedAt: { lt: cutoff } },
            { status: "REVOKED", revokedAt: { lt: cutoff } },
            { status: { in: ["PENDING", "EXPIRED"] }, expiresAt: { lt: cutoff } },
          ],
        },
        select: { id: true },
        take: MAINTENANCE_BATCH_SIZE,
      });
      if (eligible.length === 0) return 0;
      const result = await tx.membershipInvitation.deleteMany({
        where: { id: { in: eligible.map((i) => i.id) } },
      });
      return result.count;
    }),
  );
  return perTenant.reduce((a, b) => a + b, 0);
}

/** Test-only capture rows (TEST_NOTIFICATION_CAPTURE) — never present in a
 * real deployment (see testEmailCapture.ts's double gate), but a long-lived
 * local/CI test database would otherwise accumulate them indefinitely. Not
 * tenant-owned (flat `to`/`subject`/`body`), so a single unscoped sweep. */
export async function cleanupExpiredTestEmailCaptures(
  now: number = Date.now(),
): Promise<number> {
  const db = getIdentityClient();
  const cutoff = new Date(now - TEST_EMAIL_CAPTURE_RETENTION_MS);
  const eligible = await db.testEmailCapture.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true },
    take: MAINTENANCE_BATCH_SIZE,
  });
  if (eligible.length === 0) return 0;
  const result = await db.testEmailCapture.deleteMany({
    where: { id: { in: eligible.map((c) => c.id) } },
  });
  return result.count;
}

/**
 * Purges the PHYSICAL storage object behind a file that was explicitly
 * soft-deleted (`status: "DELETED"`, set by fileService.ts's `deleteFile`)
 * more than DELETED_FILE_STORAGE_RETENTION_MS ago.
 *
 * P1G-4 (Phase 1H): this function never deletes the `file_object` ROW —
 * only the bytes behind it. The row is intentionally retained afterward as
 * a non-downloadable TOMBSTONE:
 *   - Physical bytes are purged from storage once past the operational
 *     retention window (below).
 *   - The `file_object` row remains — `status` stays "DELETED" — so it can
 *     still be joined from `attachment`, referenced by `audit_event`, and
 *     inspected as revocation evidence; none of that depends on the bytes
 *     still existing.
 *   - `storagePurgedAt` (non-null) is the durable, queryable proof that
 *     physical purge already happened for this row — see point 4 below for
 *     why it also makes reruns a true no-op, not merely "safe to repeat".
 *   - Attachment history and audit history therefore stay intact even
 *     after the underlying bytes are gone — a query against either never
 *     needs to special-case "the file was garbage-collected".
 *   - Deleting the ROW itself (not just its bytes) is explicitly deferred:
 *     final database-record retention/deletion policy depends on
 *     country-specific legal review (Singapore/Malaysia/Indonesia each
 *     have their own record-retention expectations — see CLAUDE.md's
 *     regulatory-implementation-rule) which Phase 1 has not yet done. This
 *     function's job stops at storage; row deletion, if ever added, is a
 *     separate, later, explicitly-approved decision.
 *
 * Mechanics:
 *   1. Selects only rows already in the DELETED state past retention, NOT
 *      yet storage-purged — never ACTIVE or QUARANTINED (a quarantined
 *      file is kept for investigation, not auto-purged) — never deletes
 *      active or replaced content. Iterates every tenant via
 *      `withTenantContext` (see this module's own doc comment for why).
 *   2/3. `storageProvider.delete()` is `LocalStorageProvider`'s own
 *      path-traversal-checked, rooted delete (localProvider.ts) — this
 *      function never constructs a filesystem path itself.
 *   4. `storagePurgedAt` is what makes a rerun genuinely idempotent — a
 *      no-op, not just "safe to repeat": without it, the eligibility query
 *      would match the same already-purged row forever (caught by this
 *      function's own idempotency test before this marker existed).
 *      `LocalStorageProvider.delete()` is separately also idempotent
 *      (`rm(..., { force: true })`) for the rarer case of a row whose
 *      `storagePurgedAt` update failed after the storage delete succeeded.
 *   5. P1G-7 (Phase 1H): each file's storage-delete + marker-update runs
 *      between a Postgres SAVEPOINT and RELEASE/ROLLBACK TO SAVEPOINT — a
 *      genuine per-item sub-transaction inside the enclosing
 *      `withTenantContext` transaction. Without this, a database-level
 *      error on one file's UPDATE (not merely a storage-layer throw, which
 *      the try/catch alone already tolerated) would poison the WHOLE
 *      Postgres transaction — every later statement in this same batch,
 *      including subsequent files' work and the eventual COMMIT, would
 *      fail with "current transaction is aborted" until rolled back. The
 *      ROLLBACK TO SAVEPOINT undoes only that one file's (already-failed)
 *      write, leaving the transaction healthy for the rest of the batch.
 *   6. On failure, only the file's opaque id (never its storage path,
 *      original filename, or any tenant-identifying detail) is logged —
 *      neither the DB row nor its marker is touched, so a transient
 *      storage failure is naturally retried on the next maintenance cycle.
 */
export async function purgeDeletedFileObjectStorage(
  now: number = Date.now(),
): Promise<number> {
  const cutoff = new Date(now - DELETED_FILE_STORAGE_RETENTION_MS);
  const provider = getStorageProvider();
  const perTenant = await forEachTenant((tenantId) =>
    withTenantContext({ tenantId, legalEntityIds: new Set<string>() }, async (tx) => {
      const eligible = await tx.fileObject.findMany({
        where: { status: "DELETED", deletedAt: { lt: cutoff }, storagePurgedAt: null },
        select: { id: true, storageKey: true },
        take: MAINTENANCE_BATCH_SIZE,
      });
      let purged = 0;
      for (const file of eligible) {
        await tx.$executeRaw`SAVEPOINT sp_file_purge`;
        try {
          await provider.delete(file.storageKey);
          await tx.fileObject.update({
            where: { id: file.id },
            data: { storagePurgedAt: new Date(now) },
          });
          await tx.$executeRaw`RELEASE SAVEPOINT sp_file_purge`;
          purged += 1;
        } catch (e) {
          await tx.$executeRaw`ROLLBACK TO SAVEPOINT sp_file_purge`;
          console.error(
            `[retentionMaintenance] failed to purge storage object for file ${file.id}`,
            e instanceof Error ? e.message : e,
          );
        }
      }
      return purged;
    }),
  );
  return perTenant.reduce((a, b) => a + b, 0);
}
