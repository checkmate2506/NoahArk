import type { TransactionClient } from "@noahark/db";
import { getWorkerClient } from "@noahark/db/worker";

export interface EmitOutboxEventInput {
  eventType: string;
  payload: unknown;
  tenantId: string;
  legalEntityId?: string | null;
  correlationId?: string | null;
}

/** Writes an outbox row using the caller's transaction — the same
 * atomicity guarantee as enqueueJob(), for domain events (rather than
 * work items) that fan out to notifications/webhooks/projections. */
export async function emitOutboxEvent(
  tx: TransactionClient,
  input: EmitOutboxEventInput,
) {
  return tx.outboxEvent.create({
    data: {
      eventType: input.eventType,
      payload: input.payload as never,
      tenantId: input.tenantId,
      legalEntityId: input.legalEntityId ?? null,
      correlationId: input.correlationId ?? null,
    },
  });
}

const OUTBOX_TABLE = "outbox_event";

/** F-19 (Phase 1B.1): same durable-lease duration/rationale as
 * `JOB_LEASE_DURATION_MS` in queue.ts. */
export const OUTBOX_LEASE_DURATION_MS = 60_000;

export interface ClaimedOutboxEvent {
  id: string;
  tenant_id: string;
  legal_entity_id: string | null;
  event_type: string;
  payload: unknown;
  attempts: number;
  correlation_id: string | null;
}

/** F-19 (Phase 1B.1): also stamps `lease_expires_at`/`heartbeat_at` — see
 * claimNextJob in queue.ts for the full rationale; this is the identical
 * mechanism applied to outbox_event. */
export async function claimNextOutboxEvent(
  workerId: string,
): Promise<ClaimedOutboxEvent | null> {
  const db = getWorkerClient();
  const rows = await db.$queryRawUnsafe<ClaimedOutboxEvent[]>(
    `UPDATE ${OUTBOX_TABLE}
     SET status = 'PROCESSING', locked_at = now(), locked_by = $1,
         lease_expires_at = now() + ($2 * interval '1 millisecond'),
         heartbeat_at = now(),
         attempts = attempts + 1
     WHERE id = (
       SELECT id FROM ${OUTBOX_TABLE}
       WHERE status = 'PENDING'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, tenant_id, legal_entity_id, event_type, payload, attempts, correlation_id`,
    workerId,
    OUTBOX_LEASE_DURATION_MS,
  );
  return rows[0] ?? null;
}

/** F-19 (Phase 1B.1): extends a claimed outbox event's lease. See
 * heartbeatJob in queue.ts for the ownership-gating rationale. */
export async function heartbeatOutboxEvent(
  eventId: string,
  workerId: string,
): Promise<boolean> {
  const db = getWorkerClient();
  const affected = await db.$executeRawUnsafe(
    `UPDATE ${OUTBOX_TABLE}
     SET heartbeat_at = now(), lease_expires_at = now() + ($3 * interval '1 millisecond')
     WHERE id = $1 AND locked_by = $2 AND status = 'PROCESSING'`,
    eventId,
    workerId,
    OUTBOX_LEASE_DURATION_MS,
  );
  return affected > 0;
}

/** F-19 (Phase 1B.1): only the current lease owner can mark an event
 * processed — see completeJob in queue.ts for the same pattern. */
export async function markOutboxProcessed(
  eventId: string,
  workerId: string,
): Promise<boolean> {
  const db = getWorkerClient();
  const affected = await db.$executeRawUnsafe(
    `UPDATE ${OUTBOX_TABLE}
     SET status = 'PROCESSED', processed_at = now(), locked_at = NULL, locked_by = NULL,
         lease_expires_at = NULL, heartbeat_at = NULL
     WHERE id = $1 AND locked_by = $2 AND status = 'PROCESSING'`,
    eventId,
    workerId,
  );
  return affected > 0;
}

const OUTBOX_MAX_ATTEMPTS = 8;

/** F-19 (Phase 1B.1): same current-owner gate as failJob in queue.ts. */
export async function markOutboxFailed(
  eventId: string,
  workerId: string,
  attempts: number,
  error: string,
): Promise<"RETRY" | "FAILED"> {
  const db = getWorkerClient();
  if (attempts >= OUTBOX_MAX_ATTEMPTS) {
    await db.$executeRawUnsafe(
      `UPDATE ${OUTBOX_TABLE}
       SET status = 'FAILED', last_error = $3, locked_at = NULL, locked_by = NULL,
           lease_expires_at = NULL, heartbeat_at = NULL
       WHERE id = $1 AND locked_by = $2 AND status = 'PROCESSING'`,
      eventId,
      workerId,
      error,
    );
    return "FAILED";
  }
  await db.$executeRawUnsafe(
    `UPDATE ${OUTBOX_TABLE}
     SET status = 'PENDING', last_error = $3, locked_at = NULL, locked_by = NULL,
         lease_expires_at = NULL, heartbeat_at = NULL
     WHERE id = $1 AND locked_by = $2 AND status = 'PROCESSING'`,
    eventId,
    workerId,
    error,
  );
  return "RETRY";
}

export interface ReapedOutboxLease {
  id: string;
  recoveredTo: "PENDING" | "FAILED";
}

/** F-19 (Phase 1B.1): recovers outbox events stuck PROCESSING past their
 * lease — see reapExpiredJobLeases in queue.ts for the full rationale
 * (identical atomicity/concurrent-reaper-safety argument applies here). */
export async function reapExpiredOutboxLeases(
  now: Date = new Date(),
): Promise<ReapedOutboxLease[]> {
  const db = getWorkerClient();
  const rows = await db.$queryRawUnsafe<Array<{ id: string; status: string }>>(
    `UPDATE ${OUTBOX_TABLE}
     SET status = (CASE WHEN attempts >= ${OUTBOX_MAX_ATTEMPTS} THEN 'FAILED' ELSE 'PENDING' END)::"OutboxStatus",
         last_error = 'Lease expired: worker did not complete, fail, or heartbeat before lease_expires_at',
         locked_at = NULL, locked_by = NULL, lease_expires_at = NULL, heartbeat_at = NULL
     WHERE status = 'PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at < $1
     RETURNING id, status`,
    now,
  );
  return rows.map((r) => ({ id: r.id, recoveredTo: r.status as "PENDING" | "FAILED" }));
}

/**
 * P1E-4 (Phase 1F) / Phase 1H worker-DELETE hardening: deletes outbox
 * events already in a terminal state (PROCESSED or FAILED) whose
 * `created_at` is older than `retentionMs` — same rationale, shape, and
 * worker-client dependency as `cleanupTerminalJobs` in queue.ts; see its
 * doc comment in full. Phase 1H.1: the AUTHORITATIVE retention-age floor
 * lives inside `worker_cleanup_terminal_outbox_events` itself (database-
 * enforced, survives a direct hostile call bypassing this wrapper) —
 * `MIN_RETENTION_MS` below is defence in depth only.
 */
const MIN_RETENTION_MS = 60 * 60 * 1000;

export async function cleanupTerminalOutboxEvents(
  now: number = Date.now(),
  retentionMs: number = 7 * 24 * 60 * 60 * 1000,
  batchSize: number = 500,
): Promise<number> {
  const db = getWorkerClient();
  const cutoff = new Date(now - Math.max(retentionMs, MIN_RETENTION_MS));
  const rows = await db.$queryRaw<
    Array<{ deleted_count: number }>
  >`SELECT deleted_count FROM worker_cleanup_terminal_outbox_events(${cutoff}, ${batchSize})`;
  return rows[0]?.deleted_count ?? 0;
}
