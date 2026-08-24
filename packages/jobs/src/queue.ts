import type { TransactionClient } from "@noahark/db";
import { getWorkerClient } from "@noahark/db/worker";
import { ConflictError } from "@noahark/core";
import { computeBackoffMs } from "./backoff";

export interface EnqueueJobInput {
  jobType: string;
  payload: unknown;
  tenantId?: string | null;
  legalEntityId?: string | null;
  runAt?: Date;
  idempotencyKey?: string | null;
  correlationId?: string | null;
  maxAttempts?: number;
}

/**
 * Enqueues a job using the CALLER'S transaction client (from
 * `withTenantContext`), so the job row commits atomically with whatever
 * business mutation triggered it — the transactional-outbox guarantee for
 * jobs (PHASE_01_FOUNDATION §2 "PostgreSQL jobs and transactional outbox").
 *
 * If `idempotencyKey` is supplied and a job with that key already exists,
 * this is a no-op (returns the existing job) rather than throwing — retried
 * business operations must not enqueue duplicate jobs.
 */
export async function enqueueJob(tx: TransactionClient, input: EnqueueJobInput) {
  if (input.idempotencyKey) {
    const existing = await tx.backgroundJob.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) return existing;
  }

  return tx.backgroundJob.create({
    data: {
      jobType: input.jobType,
      payload: input.payload as never,
      tenantId: input.tenantId ?? null,
      legalEntityId: input.legalEntityId ?? null,
      runAt: input.runAt ?? new Date(),
      idempotencyKey: input.idempotencyKey ?? null,
      correlationId: input.correlationId ?? null,
      maxAttempts: input.maxAttempts ?? 5,
    },
  });
}

const JOB_TABLE = "background_job";

/**
 * F-19 (Phase 1B.1): how long a claimed job may run before its lease is
 * considered expired and eligible for recovery by `reapExpiredJobLeases`.
 * Deliberately generous relative to the worker's own heartbeat cadence (see
 * `startHeartbeat` in worker.ts, which re-extends the lease at roughly a
 * third of this duration) so a single missed heartbeat tick under normal
 * load never causes a spurious reap of still-healthy work.
 */
export const JOB_LEASE_DURATION_MS = 60_000;

export interface ClaimedJob {
  id: string;
  tenant_id: string | null;
  legal_entity_id: string | null;
  job_type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  correlation_id: string | null;
}

/**
 * Atomically claims the next eligible job for `workerId` using
 * `SELECT ... FOR UPDATE SKIP LOCKED`, so multiple worker processes can poll
 * concurrently without ever claiming the same row twice. Returns null if
 * nothing is ready.
 *
 * F-19 (Phase 1B.1): also stamps `lease_expires_at`/`heartbeat_at` — the
 * durable-lease pair that lets `reapExpiredJobLeases` recover a job whose
 * worker crashed mid-processing (previously a crashed worker left the job
 * PROCESSING forever, with no automatic recovery path).
 *
 * Phase 1H.2: `run_at <= now()` (and every other raw timestamp comparison
 * and `now()`-based write in this file) is safe BECAUSE `background_job`'s
 * temporal columns are genuine PostgreSQL `timestamp WITH time zone`
 * (`@db.Timestamptz(3)` in schema.prisma — see
 * `packages/db/src/temporalInventory.ts`). Phase 1H.1 live-reproduced a
 * real defect here: with the OLD naive `timestamp WITHOUT time zone`
 * columns, this same comparison silently misbehaved under a non-UTC
 * PostgreSQL session `TimeZone` (a job scheduled an hour in the future was
 * claimed immediately). Phase 1H.2 fixed this at the schema level rather
 * than patching this query — every column this file touches is now
 * unambiguously an absolute instant, so `now()`, `interval` arithmetic,
 * and direct column comparisons all mean exactly what they look like they
 * mean, with no implicit cast and no dependency on session `TimeZone`.
 * Verified directly under `UTC`/`Asia/Singapore`/`Asia/Kuala_Lumpur`/
 * `Asia/Jakarta`/a negative-offset zone — see
 * `apps/web/tests/integration/jobSchedulingTemporalMatrix.test.ts`.
 *
 * A SECOND, independent defect surfaced during the same investigation and
 * required a SECOND fix: `@prisma/adapter-pg` (the driver adapter every
 * Prisma client in this codebase uses) was found to serialize a JS `Date`
 * WRITTEN to a genuine `timestamptz` column incorrectly whenever the
 * connection's session `TimeZone` was not UTC — the value actually stored
 * on disk came out shifted by the session's UTC offset, even though the
 * column type itself was already correct. This is a write-path bug, not
 * fixable by any read-side cast. Fixed by
 * `packages/db/provisioning/provision-roles.mjs`'s
 * `ALTER DATABASE ... SET timezone TO 'UTC'`, which makes UTC the default
 * session `TimeZone` for every role connecting to a NoahArk database
 * (including the migration/system role, which this script does not
 * otherwise manage) — see that script's own doc comment and
 * `apps/web/tests/integration/temporalSchemaConformance.test.ts`'s
 * write-path regression guard, which reads a Prisma-written value back
 * through an independent raw connection to prove the bytes on disk are
 * correct, not merely what Prisma's own model layer echoes back.
 */
export async function claimNextJob(workerId: string): Promise<ClaimedJob | null> {
  const db = getWorkerClient();
  const rows = await db.$queryRawUnsafe<ClaimedJob[]>(
    `UPDATE ${JOB_TABLE}
     SET status = 'PROCESSING', locked_at = now(), locked_by = $1,
         lease_expires_at = now() + ($2 * interval '1 millisecond'),
         heartbeat_at = now(),
         attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM ${JOB_TABLE}
       WHERE status = 'PENDING' AND run_at <= now()
       ORDER BY run_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, tenant_id, legal_entity_id, job_type, payload, attempts, max_attempts, correlation_id`,
    workerId,
    JOB_LEASE_DURATION_MS,
  );
  return rows[0] ?? null;
}

/**
 * F-19 (Phase 1B.1): extends a claimed job's lease. Gated by `locked_by =
 * workerId AND status = 'PROCESSING'` so a worker whose lease has already
 * been reaped (and the job reclaimed or moved to DEAD) cannot resurrect its
 * stale claim by heartbeating past that point — the return value tells the
 * caller whether it still owns the job.
 */
export async function heartbeatJob(jobId: string, workerId: string): Promise<boolean> {
  const db = getWorkerClient();
  const affected = await db.$executeRawUnsafe(
    `UPDATE ${JOB_TABLE}
     SET heartbeat_at = now(), lease_expires_at = now() + ($3 * interval '1 millisecond')
     WHERE id = $1 AND locked_by = $2 AND status = 'PROCESSING'`,
    jobId,
    workerId,
    JOB_LEASE_DURATION_MS,
  );
  return affected > 0;
}

/**
 * F-19 (Phase 1B.1): only the current lease owner can complete a job — the
 * WHERE clause (`locked_by = workerId AND status = 'PROCESSING'`) is the
 * enforcement. If a job's lease expired and was reclaimed (or the job was
 * declared DEAD) while this worker was still running its handler, this
 * returns `false` and the job is left exactly as the reaper/new owner left
 * it — a stale worker can never overwrite a newer claim. Handlers must be
 * idempotent for this reason: at-least-once delivery is the guarantee, not
 * exactly-once.
 */
export async function completeJob(jobId: string, workerId: string): Promise<boolean> {
  const db = getWorkerClient();
  const affected = await db.$executeRawUnsafe(
    `UPDATE ${JOB_TABLE}
     SET status = 'SUCCEEDED', locked_at = NULL, locked_by = NULL,
         lease_expires_at = NULL, heartbeat_at = NULL, updated_at = now()
     WHERE id = $1 AND locked_by = $2 AND status = 'PROCESSING'`,
    jobId,
    workerId,
  );
  return affected > 0;
}

export interface FailJobInput {
  jobId: string;
  workerId: string;
  attempts: number;
  maxAttempts: number;
  error: string;
}

/** On failure: retries with exponential backoff until `maxAttempts` is
 * reached, then moves the job to DEAD (terminal-failure / dead-letter).
 *
 * F-19 (Phase 1B.1): same current-owner gate as completeJob — a stale
 * worker's failure report after its lease was reaped is a no-op (returns
 * the outcome it WOULD have produced, for logging, but does not touch the
 * row, which the reaper/new owner already own). */
export async function failJob(input: FailJobInput): Promise<"RETRY" | "DEAD"> {
  const db = getWorkerClient();
  if (input.attempts >= input.maxAttempts) {
    await db.$executeRawUnsafe(
      `UPDATE ${JOB_TABLE}
       SET status = 'DEAD', last_error = $3, locked_at = NULL, locked_by = NULL,
           lease_expires_at = NULL, heartbeat_at = NULL, updated_at = now()
       WHERE id = $1 AND locked_by = $2 AND status = 'PROCESSING'`,
      input.jobId,
      input.workerId,
      input.error,
    );
    return "DEAD";
  }

  const delayMs = computeBackoffMs(input.attempts);
  await db.$executeRawUnsafe(
    `UPDATE ${JOB_TABLE}
     SET status = 'PENDING', last_error = $3, run_at = $4, locked_at = NULL, locked_by = NULL,
         lease_expires_at = NULL, heartbeat_at = NULL, updated_at = now()
     WHERE id = $1 AND locked_by = $2 AND status = 'PROCESSING'`,
    input.jobId,
    input.workerId,
    input.error,
    new Date(Date.now() + delayMs),
  );
  return "RETRY";
}

export interface ReapedJobLease {
  id: string;
  recoveredTo: "PENDING" | "DEAD";
}

/**
 * F-19 (Phase 1B.1): recovers jobs stuck PROCESSING because the worker that
 * claimed them crashed (or was killed, or partitioned) before completing,
 * failing, or heartbeating past `lease_expires_at`. Moves each to PENDING
 * (retryable — `attempts` was already incremented at claim time, so this
 * does NOT double-count) if `attempts < max_attempts`, otherwise DEAD.
 *
 * The recovery decision and the state transition happen in a SINGLE atomic
 * UPDATE, which is what makes this safe to run from multiple concurrent
 * reaper processes/ticks: Postgres row-locks each matched row for the
 * statement's duration, and the `WHERE status = 'PROCESSING'` clause means
 * a second, concurrent reaper (or a second call racing the first) simply
 * matches zero rows for anything the first reaper already moved out of
 * PROCESSING — there is no read-then-write gap for two reapers to land in.
 */
export async function reapExpiredJobLeases(
  now: Date = new Date(),
): Promise<ReapedJobLease[]> {
  const db = getWorkerClient();
  const rows = await db.$queryRawUnsafe<Array<{ id: string; status: string }>>(
    `UPDATE ${JOB_TABLE}
     SET status = (CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'PENDING' END)::"JobStatus",
         last_error = 'Lease expired: worker did not complete, fail, or heartbeat before lease_expires_at',
         run_at = CASE WHEN attempts >= max_attempts THEN run_at ELSE now() END,
         locked_at = NULL, locked_by = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
         updated_at = now()
     WHERE status = 'PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at < $1
     RETURNING id, status`,
    now,
  );
  return rows.map((r) => ({ id: r.id, recoveredTo: r.status as "PENDING" | "DEAD" }));
}

/**
 * P1E-4 (Phase 1F) / Phase 1H worker-DELETE hardening: deletes jobs already
 * in a terminal state (SUCCEEDED or DEAD) whose `updated_at` (bumped on the
 * very transition into that state by completeJob/failJob) is older than
 * `retentionMs`. Lives here — not in apps/web/lib/retentionMaintenance.ts
 * alongside the app's other retention routines — because `background_job`
 * is tenant-owned and this needs to see every tenant's rows in one sweep;
 * `noahark_worker`'s RLS policy is SPECIFICALLY scoped to allow that
 * (ADR-31), and this package is the only place that role's client
 * (`getWorkerClient()`) is used — see this package's own module-level doc
 * comments elsewhere for why the app-runtime ESLint import boundary
 * (N-3/P1E-2) exempts `packages/jobs` from the worker-client restriction.
 *
 * Phase 1H: `noahark_worker` no longer has a direct DELETE grant on this
 * table at all (see the RLS migration's "Worker DELETE hardening"
 * section) — this now calls `worker_cleanup_terminal_jobs(cutoff,
 * batch_size)`, a SECURITY DEFINER SQL function that independently
 * re-enforces terminal status (both its own WHERE clause and the owning
 * role's own RLS DELETE policy — two layers) and a batch-size cap, all
 * INSIDE the database, and returns only a deleted count. `noahark_worker`
 * cannot delete a PENDING/PROCESSING row, or delete anything outside a
 * bounded batch, through any query this client could issue — that's a
 * database fact, not merely this file's own `where` clause.
 *
 * Phase 1H.1: the retention-AGE floor is now ALSO enforced INSIDE
 * `worker_cleanup_terminal_jobs` itself (`clock_timestamp() - interval
 * '1 hour'`, clamped via `LEAST` against the caller's cutoff — see the
 * RLS migration's own doc comment on that function for the full design
 * and the live adversarial evidence). That is the AUTHORITATIVE control:
 * it holds even if this TypeScript wrapper is bypassed entirely and the
 * SQL function is called directly by the worker role with a hostile
 * cutoff (a future date, an extreme value, etc.) — see
 * apps/web/tests/integration/workerDeleteHardening.test.ts's direct-role
 * tests, which call the function exactly that way.
 *
 * `MIN_RETENTION_MS` below is DEFENCE IN DEPTH ONLY, not the security
 * boundary — Phase 1H originally (incorrectly) treated the
 * application-side clamp as authoritative, believing the database-side
 * clamp was defeated by "clock skew" between the Postgres server and the
 * Node process. Phase 1H.1 measured this directly and found NO clock
 * drift (`clock_timestamp()` matches `Date.now()` to within ~100ms on
 * this project's local dev/test Postgres instance) — the real defect was
 * an implicit-cast hazard comparing a naive `timestamp` column against a
 * `timestamptz` value under a non-UTC session `TimeZone` (this instance
 * defaults to `Asia/Kuala_Lumpur`), initially worked around with an
 * explicit `AT TIME ZONE 'UTC'` conversion inside the SQL function.
 * Phase 1H.2 removed that workaround: `background_job`'s columns are now
 * genuine `timestamptz` (see `claimNextJob`'s own doc comment above), so
 * the comparison inside `worker_cleanup_terminal_jobs` needs no
 * conversion at all. See `docs/DECISION_REGISTER.md`'s Phase 1H.1 and
 * Phase 1H.2 sections for the full investigation and evidence.
 */
const MIN_RETENTION_MS = 60 * 60 * 1000;

export async function cleanupTerminalJobs(
  now: number = Date.now(),
  retentionMs: number = 7 * 24 * 60 * 60 * 1000,
  batchSize: number = 500,
): Promise<number> {
  const db = getWorkerClient();
  const cutoff = new Date(now - Math.max(retentionMs, MIN_RETENTION_MS));
  const rows = await db.$queryRaw<
    Array<{ deleted_count: number }>
  >`SELECT deleted_count FROM worker_cleanup_terminal_jobs(${cutoff}, ${batchSize})`;
  return rows[0]?.deleted_count ?? 0;
}

/** Fetches a durable job's current status for admin/observability screens
 * (JOB_READ permission) — read through the RLS-enforced app client via
 * `withTenantContext`, not this package, so tenant scoping is enforced. */
export function assertKnownJobType(jobType: string, known: readonly string[]): void {
  if (!known.includes(jobType)) {
    throw new ConflictError(`No handler registered for job type: ${jobType}`);
  }
}
