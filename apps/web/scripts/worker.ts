/**
 * Standalone background-worker process. Run separately from the Next.js
 * server (`tsx scripts/worker.ts`) — polls background_job and outbox_event
 * via the noahark_worker (BYPASSRLS-but-grant-limited) role.
 *
 * No job or outbox event TYPES are registered yet: Phase 1 has no business
 * events to react to (no CRM/accounting/payroll). This script exists so the
 * queue mechanism is exercised end-to-end (see packages/jobs' integration
 * tests) rather than merely being a library nothing ever runs. Later
 * phases register real handlers in the two maps below.
 */
import "dotenv/config";
import { startWorkerLoop, type JobHandler, type OutboxHandler } from "@noahark/jobs";
import { MAINTENANCE_TASKS } from "@/lib/maintenanceRegistry";

const jobHandlers: Record<string, JobHandler> = {};
const outboxHandlers: Record<string, OutboxHandler> = {};

const workerId = `worker-${process.pid}-${Date.now()}`;
console.warn(`[worker] starting as ${workerId}`);

// N-5 (Phase 1D) / P1E-4 (Phase 1F): retention/cleanup routines — see
// packages/jobs/src/maintenance.ts for the generic sweep mechanism,
// apps/web/lib/maintenanceRegistry.ts for the full category inventory
// (also covered by its own test, so a category can't go unregistered
// silently again), and each task's own module for why it exists.
const handle = startWorkerLoop(workerId, jobHandlers, outboxHandlers, {
  pollIntervalMs: 1000,
  maintenanceTasks: MAINTENANCE_TASKS,
});

async function shutdown(signal: string) {
  console.warn(`[worker] received ${signal}, stopping...`);
  await handle.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
