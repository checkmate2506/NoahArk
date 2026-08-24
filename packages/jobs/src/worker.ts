import type { TransactionClient } from "@noahark/db";
import {
  claimNextJob,
  completeJob,
  failJob,
  reapExpiredJobLeases,
  heartbeatJob,
  JOB_LEASE_DURATION_MS,
} from "./queue";
import {
  claimNextOutboxEvent,
  markOutboxProcessed,
  markOutboxFailed,
  reapExpiredOutboxLeases,
  heartbeatOutboxEvent,
  OUTBOX_LEASE_DURATION_MS,
} from "./outbox";
import {
  withJobTenantContext,
  recordJobContextFailure,
  JobOwnershipError,
} from "./context";
import { runMaintenanceTasks, type MaintenanceTask } from "./maintenance";

/**
 * F-20 (Phase 1B.1): `tx` is a REAL scoped `TransactionClient` (RLS-
 * enforced `noahark_app` role, `app.tenant_id`/`app.legal_entity_ids` set
 * from the claimed job's OWN persisted columns — see context.ts) — not a
 * raw id the handler must remember to scope itself with. This is the only
 * database client a handler ever receives; there is no path from here to
 * the worker's own `noahark_worker`-role client or to an unscoped app
 * client.
 */
export interface JobHandlerContext {
  jobId: string;
  tenantId: string;
  legalEntityId: string | null;
  correlationId: string | null;
  attempts: number;
  tx: TransactionClient;
}

export type JobHandler = (payload: unknown, ctx: JobHandlerContext) => Promise<void>;

export type JobIterationResult = "EMPTY" | "SUCCEEDED" | "RETRY" | "DEAD";

/** F-19 (Phase 1B.1): runs `heartbeat` on an interval for the duration of
 * `work`, so a handler that runs longer than one lease period doesn't get
 * its job reclaimed out from under it. The interval is a third of the
 * lease duration, matching JOB_LEASE_DURATION_MS's own doc comment — a
 * single missed tick (e.g. a slow heartbeat query) still leaves margin
 * before the lease actually expires. Heartbeat failures are logged, not
 * thrown — a transient heartbeat failure should not abort an otherwise
 * successful handler; if the lease genuinely expires, completeJob/failJob's
 * own ownership check is the real backstop (see queue.ts). */
async function withHeartbeat<T>(
  intervalMs: number,
  heartbeat: () => Promise<void>,
  work: () => Promise<T>,
): Promise<T> {
  const timer = setInterval(() => {
    heartbeat().catch((e) => {
      console.error("[jobs] heartbeat failed", e);
    });
  }, intervalMs);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/** Runs a single claim → handle → complete/fail cycle. No I/O beyond the
 * claim/complete/fail calls and the handler itself, so this is the unit
 * boundary integration tests should exercise for retry/dead-letter
 * behaviour without needing a real polling loop running in the background.
 *
 * F-19 (Phase 1B.1): completeJob/failJob are gated on `workerId` still
 * holding the lease — see queue.ts. If the lease was reaped mid-handler
 * (this worker crashed/stalled past JOB_LEASE_DURATION_MS with no
 * heartbeat reaching the database), completeJob/failJob become no-ops and
 * this function's return value describes what THIS worker attempted, not
 * necessarily the job's final row state — the reaper or a subsequent
 * worker owns that outcome instead.
 *
 * F-20 (Phase 1B.1): the handler now runs INSIDE `withJobTenantContext`,
 * scoped from the claimed row's own `tenant_id`/`legal_entity_id` — never
 * from `payload`. If that ownership cannot be turned into a valid scoped
 * context at all (missing tenant, or a legal entity that doesn't belong to
 * its own tenant — both only possible via a bug or tampering elsewhere),
 * the failure is recorded via `recordJobContextFailure` and the job is
 * failed through the ordinary retry/DEAD accounting — a persistent
 * ownership problem will not resolve itself on retry, but there is no
 * separate "permanently unrunnable" terminal state in Phase 1, so it
 * follows the same maxAttempts path as any other failure. */
export async function runOneJob(
  workerId: string,
  handlers: Readonly<Record<string, JobHandler>>,
): Promise<JobIterationResult> {
  const claimed = await claimNextJob(workerId);
  if (!claimed) return "EMPTY";

  const ownership = {
    tenantId: claimed.tenant_id,
    legalEntityId: claimed.legal_entity_id,
  };

  try {
    const handler = handlers[claimed.job_type];
    if (!handler)
      throw new Error(`No handler registered for job type: ${claimed.job_type}`);

    await withJobTenantContext(ownership, (tx) =>
      withHeartbeat(
        Math.floor(JOB_LEASE_DURATION_MS / 3),
        () => heartbeatJob(claimed.id, workerId).then(() => undefined),
        () =>
          handler(claimed.payload, {
            jobId: claimed.id,
            tenantId: ownership.tenantId as string,
            legalEntityId: claimed.legal_entity_id,
            correlationId: claimed.correlation_id,
            attempts: claimed.attempts,
            tx,
          }),
      ),
    );
    await completeJob(claimed.id, workerId);
    return "SUCCEEDED";
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof JobOwnershipError) {
      await recordJobContextFailure({
        jobId: claimed.id,
        jobKind: "job",
        jobType: claimed.job_type,
        ownership,
        reason: message,
      });
    }
    return failJob({
      jobId: claimed.id,
      workerId,
      attempts: claimed.attempts,
      maxAttempts: claimed.max_attempts,
      error: message,
    });
  }
}

export interface OutboxHandlerContext {
  eventId: string;
  tenantId: string;
  legalEntityId: string | null;
  correlationId: string | null;
  tx: TransactionClient;
}

export type OutboxHandler = (
  payload: unknown,
  ctx: OutboxHandlerContext,
) => Promise<void>;
export type OutboxIterationResult = "EMPTY" | "PROCESSED" | "RETRY" | "FAILED";

/** F-20 (Phase 1B.1): same scoped-context treatment as runOneJob — see its
 * doc comment. Outbox events always have a non-null tenantId at the schema
 * level, so the only ownership failure possible here is an inconsistent
 * legal_entity_id (belongs to a different tenant). */
export async function runOneOutboxEvent(
  workerId: string,
  handlers: Readonly<Record<string, OutboxHandler>>,
): Promise<OutboxIterationResult> {
  const claimed = await claimNextOutboxEvent(workerId);
  if (!claimed) return "EMPTY";

  const ownership = {
    tenantId: claimed.tenant_id,
    legalEntityId: claimed.legal_entity_id,
  };

  try {
    const handler = handlers[claimed.event_type];
    if (!handler)
      throw new Error(`No handler registered for event type: ${claimed.event_type}`);

    await withJobTenantContext(ownership, (tx) =>
      withHeartbeat(
        Math.floor(OUTBOX_LEASE_DURATION_MS / 3),
        () => heartbeatOutboxEvent(claimed.id, workerId).then(() => undefined),
        () =>
          handler(claimed.payload, {
            eventId: claimed.id,
            tenantId: claimed.tenant_id,
            legalEntityId: claimed.legal_entity_id,
            correlationId: claimed.correlation_id,
            tx,
          }),
      ),
    );
    await markOutboxProcessed(claimed.id, workerId);
    return "PROCESSED";
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof JobOwnershipError) {
      await recordJobContextFailure({
        jobId: claimed.id,
        jobKind: "outbox_event",
        jobType: claimed.event_type,
        ownership,
        reason: message,
      });
    }
    return markOutboxFailed(claimed.id, workerId, claimed.attempts, message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WorkerLoopHandle {
  stop: () => Promise<void>;
}

/** F-19 (Phase 1B.1): how often the reaper sweep for expired leases runs.
 * Independent of pollIntervalMs (which governs claim attempts) — reaping
 * is cheap (a single indexed UPDATE per table, see queue.ts/outbox.ts) but
 * still need not run on every single poll tick under normal load. */
const DEFAULT_REAP_INTERVAL_MS = 30_000;

/** N-5 (Phase 1D): how often the retention/cleanup sweep runs — see
 * maintenance.ts. Deliberately much coarser than DEFAULT_REAP_INTERVAL_MS:
 * unlike lease reaping (correctness-critical — a stuck lease blocks a real
 * job from ever being retried), retention cleanup is pure housekeeping
 * with no correctness deadline, so there is no benefit to running it
 * often, only unnecessary load. */
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

/** Thin polling wrapper around runOneJob/runOneOutboxEvent for a standalone
 * worker process. Each iteration is independently safe (see runOneJob) —
 * this function only adds the poll/backoff-when-idle behaviour, plus (F-19,
 * Phase 1B.1) a periodic sweep recovering jobs/outbox events left
 * PROCESSING by a worker that crashed before its lease expired, and (N-5,
 * Phase 1D) a separate, much coarser periodic sweep running caller-supplied
 * retention/cleanup tasks (see maintenance.ts) — empty by default, so a
 * caller that doesn't need one pays nothing extra. Multiple worker
 * processes each running their own loop all safely race the lease-reap
 * sweep — see reapExpiredJobLeases/reapExpiredOutboxLeases for why
 * concurrent reapers cannot double-recover a row; maintenance tasks are
 * likewise safe to run concurrently from multiple processes (see
 * maintenance.ts's own doc comment). */
export function startWorkerLoop(
  workerId: string,
  jobHandlers: Readonly<Record<string, JobHandler>>,
  outboxHandlers: Readonly<Record<string, OutboxHandler>>,
  options: {
    pollIntervalMs?: number;
    reapIntervalMs?: number;
    maintenanceTasks?: Readonly<Record<string, MaintenanceTask>>;
    maintenanceIntervalMs?: number;
  } = {},
): WorkerLoopHandle {
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const reapIntervalMs = options.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  const maintenanceTasks = options.maintenanceTasks ?? {};
  const maintenanceIntervalMs =
    options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
  let stopped = false;
  let nextReapAt = 0;
  let nextMaintenanceAt = 0;

  const loop = async () => {
    while (!stopped) {
      if (Date.now() >= nextReapAt) {
        await Promise.all([reapExpiredJobLeases(), reapExpiredOutboxLeases()]).catch(
          (e) => {
            console.error("[jobs] lease reap sweep failed", e);
          },
        );
        nextReapAt = Date.now() + reapIntervalMs;
      }

      if (Object.keys(maintenanceTasks).length > 0 && Date.now() >= nextMaintenanceAt) {
        await runMaintenanceTasks(maintenanceTasks);
        nextMaintenanceAt = Date.now() + maintenanceIntervalMs;
      }

      const jobResult = await runOneJob(workerId, jobHandlers);
      const outboxResult = await runOneOutboxEvent(workerId, outboxHandlers);
      if (jobResult === "EMPTY" && outboxResult === "EMPTY") {
        await sleep(pollIntervalMs);
      }
    }
  };

  const finished = loop();
  return {
    stop: async () => {
      stopped = true;
      await finished;
    },
  };
}
