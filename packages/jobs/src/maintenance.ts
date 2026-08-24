/**
 * N-5 (Phase 1D): generic periodic-maintenance primitive for
 * `startWorkerLoop`. Retention/cleanup routines (expired rate-limit
 * buckets, expired verification/MFA-challenge tokens, ...) are pure
 * housekeeping — safe to skip a cycle, safe to run concurrently from
 * multiple worker processes (each is a plain `deleteMany` on an
 * already-expired condition, idempotent by construction) — unlike job/
 * outbox lease reaping, which is correctness-critical and already has its
 * own dedicated sweep (see worker.ts's reapExpiredJobLeases/
 * reapExpiredOutboxLeases).
 *
 * This package stays app-agnostic: it defines WHEN maintenance runs, not
 * WHAT it does. The actual task functions (packages/jobs has no reason to
 * know about rate limiters or verification tokens — those are apps/web
 * concerns) are supplied by the caller, exactly like jobHandlers/
 * outboxHandlers are — see apps/web/scripts/worker.ts.
 */

/** Returns the number of rows it cleaned up, purely for logging — never
 * throws on its own; a failing task must not prevent the others from
 * running. */
export type MaintenanceTask = () => Promise<number>;

/** Runs every supplied task once, independently. A single task's failure
 * is logged and does not stop the others — matches the fail-open,
 * housekeeping-only nature of retention cleanup (see this file's own doc
 * comment). */
export async function runMaintenanceTasks(
  tasks: Readonly<Record<string, MaintenanceTask>>,
): Promise<void> {
  await Promise.all(
    Object.entries(tasks).map(async ([name, task]) => {
      try {
        const count = await task();
        if (count > 0) {
          console.warn(`[jobs] maintenance task "${name}" cleaned up ${count} row(s)`);
        }
      } catch (e) {
        console.error(`[jobs] maintenance task "${name}" failed`, e);
      }
    }),
  );
}
