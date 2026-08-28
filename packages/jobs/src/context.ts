import {
  withTenantContext,
  withPlatformAuditContext,
  writeAuditEventInTx,
  type TransactionClient,
} from "@noahark/db";
import { AUDIT_ACTIONS, type AuditEventInput } from "@noahark/audit";

/**
 * F-20 (Phase 1B.1): this is the ONLY place a job/outbox handler receives a
 * database client — a `TransactionClient` from a real `withTenantContext`
 * call, running as the RLS-enforced `noahark_app` role, scoped to exactly
 * the tenant (and, where applicable, the single legal entity) the claimed
 * job/event row itself records. Handlers never see the worker's own
 * `noahark_worker`-role client (that client is confined to
 * queue.ts/outbox.ts's claim/complete/fail/heartbeat/reap calls in this
 * package and is never passed to a handler) and never see an unscoped app
 * client either — there is no code path from a handler back to an
 * unrestricted client.
 *
 * Previously (pre-Phase-1B.1), handlers were merely handed the tenantId/
 * legalEntityId STRINGS from the claimed row — "context" meant nothing more
 * than passing those two values along; a handler that wanted to touch the
 * database had to remember to open its own `withTenantContext` (easy to
 * forget, or to get subtly wrong, e.g. by trusting a tenantId read back out
 * of `payload` instead of the persisted job row). This module closes that
 * gap: `withJobTenantContext` is the ONLY sanctioned way from this package
 * to obtain a scoped client for a claimed job, and it derives ownership
 * exclusively from the row Postgres actually returned to `claimNextJob`/
 * `claimNextOutboxEvent` — `payload` is never consulted for tenant/legal-
 * entity identity, so a handler cannot be tricked into a different scope by
 * a crafted payload field of the same name.
 */
export interface JobOwnership {
  tenantId: string | null;
  legalEntityId: string | null;
}

export class JobOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobOwnershipError";
  }
}

/**
 * Records a security-relevant context failure — a job/outbox row whose
 * persisted ownership could not be turned into a valid scoped database
 * context at all (missing tenant, or a legal_entity_id that does not
 * belong to its own tenant_id). Both cases can only arise from a bug
 * elsewhere (enqueueJob/emitOutboxEvent always persist a real tenantId for
 * outbox events, and a valid pairing for jobs) or direct database
 * tampering — either way, "loud and recorded" is required, not silent.
 *
 * A missing tenantId cannot be attributed to ANY tenant's own audit chain
 * (there is no tenant to scope it to) — it is written to the PLATFORM
 * chain instead, the same `withPlatformAuditContext` used today for sign-
 * in/sign-out/failed-login (see packages/db/src/client.ts's doc comment:
 * "a future cross-tenant admin capability would reuse this same context
 * setter" — this is exactly that). An invalid/cross-tenant legal entity
 * DOES have a known tenantId, so it is written to that tenant's own chain
 * instead, which is strictly more specific and discoverable by that
 * tenant's own audit views.
 */
export async function recordJobContextFailure(details: {
  jobId: string;
  jobKind: "job" | "outbox_event";
  jobType: string;
  ownership: JobOwnership;
  reason: string;
}): Promise<void> {
  const input: AuditEventInput = {
    tenantId: details.ownership.tenantId,
    legalEntityId: details.ownership.legalEntityId,
    actorUserId: null,
    actorType: "SYSTEM",
    action: AUDIT_ACTIONS.JOB_CONTEXT_REJECTED,
    entityType: details.jobKind,
    entityId: details.jobId,
    afterData: { jobType: details.jobType, reason: details.reason },
    outcome: "DENIED",
  };

  try {
    if (details.ownership.tenantId) {
      await withTenantContext(
        { tenantId: details.ownership.tenantId, legalEntityIds: new Set() },
        (tx) => writeAuditEventRaw(tx, input),
      );
    } else {
      await withPlatformAuditContext((tx) => writeAuditEventRaw(tx, input));
    }
  } catch (e) {
    // Auditing the failure must never itself become a reason the worker
    // crashes or the underlying ownership failure goes unhandled — log and
    // move on; the caller (withJobTenantContext) still throws/fails the
    // job either way.
    console.error("[jobs] failed to record job context failure audit event", e);
  }
}

/** Compatibility delegate (ADR-76). Persistence lives in
 * `writeAuditEventInTx` (`@noahark/db`). This wrapper exists only so
 * `recordJobContextFailure` keeps its historical call shape: it already
 * holds a `TransactionClient` from `withTenantContext` or
 * `withPlatformAuditContext` and must not open a second transaction.
 * `@noahark/jobs` already depends on `@noahark/db`; the original copy
 * existed because the writer previously lived in `apps/web`, which depends
 * on this package. */
async function writeAuditEventRaw(tx: TransactionClient, input: AuditEventInput) {
  return writeAuditEventInTx(tx, input);
}

/**
 * F-20 (Phase 1B.1): enters the scoped database context a job/outbox
 * handler runs inside, deriving `tenantId`/`legalEntityId` EXCLUSIVELY from
 * `ownership` — which callers (runOneJob/runOneOutboxEvent) must build only
 * from the claimed row's own columns, never from `payload`.
 *
 * - No `tenantId` at all: fails closed with `JobOwnershipError` (and the
 *   caller records it via recordJobContextFailure) — there is no
 *   "unscoped tenant work" concept; every handler runs inside a real
 *   tenant's RLS scope or does not run at all.
 * - A `legalEntityId` is present: verified (a real read against
 *   `legal_entity`, scoped to `ownership.tenantId`) to actually belong to
 *   that same tenant BEFORE it is trusted to scope the handler's context —
 *   this can only fail via a bug or tampering elsewhere, but this function
 *   fails closed and loud rather than silently unioning an entity from one
 *   tenant into a scope claiming to be another.
 * - No `legalEntityId` (a genuinely tenant-wide job): the FULL set of the
 *   tenant's own legal entity ids is resolved from the database (never
 *   from payload) and used to scope the handler's context, so entity-
 *   scoped tables stay visible to work that legitimately spans every
 *   entity in the tenant.
 */
export async function withJobTenantContext<T>(
  ownership: JobOwnership,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  if (!ownership.tenantId) {
    throw new JobOwnershipError(
      "Job/outbox row has no tenant ownership (tenant_id is null) — refusing to enter an unscoped database context for handler execution.",
    );
  }
  const tenantId = ownership.tenantId;

  if (ownership.legalEntityId) {
    const legalEntityId = ownership.legalEntityId;
    const belongs = await withTenantContext(
      { tenantId, legalEntityIds: new Set() },
      (tx) =>
        tx.legalEntity.findUnique({ where: { id: legalEntityId }, select: { id: true } }),
    );
    if (!belongs) {
      throw new JobOwnershipError(
        `Job/outbox row's legal_entity_id (${legalEntityId}) does not belong to its own tenant_id (${tenantId}) — refusing to enter a scoped database context.`,
      );
    }
    return withTenantContext({ tenantId, legalEntityIds: new Set([legalEntityId]) }, fn);
  }

  const legalEntityIds = await withTenantContext(
    { tenantId, legalEntityIds: new Set() },
    async (tx) => {
      const entities = await tx.legalEntity.findMany({
        where: { tenantId },
        select: { id: true },
      });
      return new Set(entities.map((e) => e.id));
    },
  );

  return withTenantContext({ tenantId, legalEntityIds }, fn);
}
