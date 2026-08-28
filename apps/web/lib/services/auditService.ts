import {
  writeAuditEventInTx,
  type TransactionClient,
  withTenantContext,
} from "@noahark/db";
import type { AuditEventInput } from "@noahark/audit";
import { authorize, PERMISSIONS } from "@noahark/authz";
import { ValidationError, type AccessContext } from "@noahark/core";
import { emitOutboxEvent, type EmitOutboxEventInput } from "@noahark/jobs";

/**
 * Appends one audit event to its chain (tenant-scoped, or the "platform"
 * chain for tenantId === null). `pg_advisory_xact_lock` serializes
 * concurrent writers to the SAME chain for the lifetime of this
 * transaction, so two concurrent requests can never both read the same
 * "latest hash"/sequence and each append a link claiming to follow it —
 * without the lock, that race could fork the chain.
 *
 * F-2/F-6 (Phase 1B): the predecessor is looked up by `sequence DESC`
 * (unique per chainKey, monotonic) rather than `createdAt DESC`.
 * `createdAt` is TIMESTAMP(3) and ties routinely under real concurrency —
 * verified directly against Postgres during the Phase 1A review, back-to-
 * back writes tied 1000/1000 times — which made the old lookup pick an
 * arbitrary predecessor and could fork the chain even under the advisory
 * lock (the lock serializes writers, but two writers can still each see the
 * same tied `createdAt` "latest" row and both compute the next hash from
 * it). `sequence` has no ties by construction: it is read-and-incremented
 * exactly once per chainKey while holding the lock.
 */
export async function writeAuditEvent(tx: TransactionClient, input: AuditEventInput) {
  return writeAuditEventInTx(tx, input);
}

export type { AuditEventInput };

/**
 * F-3D (Phase 1B) — the boundary between three distinct mechanisms this
 * codebase now has, clarified explicitly because Phase 1A found it
 * ambiguous:
 *
 *   1. SYNCHRONOUS security audit event (writeAuditEvent, above). Written
 *      directly, in the SAME transaction as the business mutation it
 *      records, by the request-handling process itself — never routed
 *      through a worker or queue. This is why a security-critical audit
 *      record can never be lost to a worker failure: there is no worker
 *      in this path at all. This is the authoritative, tamper-evident
 *      record (packages/audit's hash chain) and the ONLY thing Phase 1
 *      calls "the audit trail."
 *
 *   2. TRANSACTIONAL OUTBOX EVENT (emitOutboxEvent, @noahark/jobs — this
 *      wrapper). Also written in the SAME transaction as the business
 *      mutation (and, by convention here, alongside its audit event), but
 *      it is NOT the audit trail — it is a durable, at-least-once queue
 *      row for later ASYNCHRONOUS fan-out (a future webhook, search-index
 *      projection, or cross-system notification). A worker polls it via
 *      `packages/jobs`'s `claimNextOutboxEvent`/`runOneOutboxEvent`, with
 *      its own independent retry/failure accounting
 *      (`markOutboxFailed`, capped at 8 attempts before terminal FAILED).
 *      If that worker-side delivery fails or is delayed, the audit record
 *      from (1) is entirely unaffected — it already committed.
 *
 *   3. ASYNCHRONOUS notification/integration delivery (packages/jobs'
 *      `runOneOutboxEvent` + a registered OutboxHandler, or the
 *      background-job queue for non-event-shaped work). This is what
 *      actually consumes (2); Phase 1 registers no handlers (no external
 *      integrations exist yet), so any emitted outbox event will sit
 *      PENDING until a later phase adds one — which is fine, since (1)
 *      already recorded the fact durably and outside this path entirely.
 *
 * `writeAuditEventAndOutbox` is a convenience for call sites that want
 * both (1) and (2) for the same action, in one transaction. Phase 1 wires
 * it into exactly one representative flow (roleService.assignRole) to
 * prove the pattern end-to-end with real tests, rather than retrofitting
 * every mutation — a later phase should adopt it wherever an outbox
 * consumer actually needs to react to that specific event type.
 */
export async function writeAuditEventAndOutbox(
  tx: TransactionClient,
  auditInput: AuditEventInput,
  outboxInput: Omit<EmitOutboxEventInput, "tenantId" | "legalEntityId"> & {
    legalEntityId?: string | null;
  },
) {
  if (!auditInput.tenantId) {
    throw new Error(
      "writeAuditEventAndOutbox requires a non-null tenantId (outbox events are always tenant-owned)",
    );
  }
  const auditEvent = await writeAuditEvent(tx, auditInput);
  const outboxEvent = await emitOutboxEvent(tx, {
    ...outboxInput,
    tenantId: auditInput.tenantId,
    legalEntityId: outboxInput.legalEntityId ?? auditInput.legalEntityId ?? null,
  });
  return { auditEvent, outboxEvent };
}

export interface ListAuditEventsInput {
  cursor?: string | undefined;
  limit?: number | undefined;
}

/**
 * F-32 (Phase 1B.1): the cursor encodes the last row's `sequence` — the
 * monotonic, gap-free, per-chain BigInt column (see schema.prisma's
 * AuditEvent doc comment and F-2/F-6 above) — rather than `createdAt` or a
 * raw row id. This is the fix for a real instability: `createdAt` is
 * TIMESTAMP(3) and ties routinely under real concurrency (verified
 * directly against Postgres — see the F-2/F-6 comment on writeAuditEvent),
 * so a cursor built from `orderBy: createdAt` + `cursor: { id }, skip: 1`
 * could skip or duplicate rows across ties whenever two events landed in
 * the same millisecond, which happens easily under load. `sequence` has no
 * ties by construction (allocated exactly once per chainKey while holding
 * the writer's advisory lock), so bounding the next page with `sequence <
 * cursorSequence` is unconditionally stable: no duplicates, no skips,
 * regardless of how many events share an identical `createdAt`.
 *
 * The cursor is opaque to callers (base64url of the decimal sequence
 * string) — decoding validates strictly and throws ValidationError (never
 * a raw parse crash) on anything malformed. A forged/out-of-range cursor
 * cannot change tenant scope: the WHERE clause always ANDs in `tenantId:
 * ctx.tenantId` on top of the sequence bound, and RLS enforces the same
 * boundary again at the database — a cursor can only shrink or (harmlessly)
 * empty the caller's OWN page, never reach another tenant's rows.
 */
function encodeAuditCursor(sequence: bigint): string {
  return Buffer.from(sequence.toString(), "utf8").toString("base64url");
}

function decodeAuditCursor(cursor: string): bigint {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new ValidationError("Invalid pagination cursor");
  }
  if (!/^\d+$/.test(decoded)) {
    throw new ValidationError("Invalid pagination cursor");
  }
  try {
    return BigInt(decoded);
  } catch {
    throw new ValidationError("Invalid pagination cursor");
  }
}

export async function listAuditEvents(
  ctx: AccessContext,
  input: ListAuditEventsInput = {},
) {
  authorize(ctx, { permission: PERMISSIONS.AUDIT_READ });
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const cursorSequence = input.cursor ? decodeAuditCursor(input.cursor) : null;

  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds },
    async (tx) => {
      const events = await tx.auditEvent.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(cursorSequence !== null ? { sequence: { lt: cursorSequence } } : {}),
        },
        orderBy: { sequence: "desc" },
        take: limit + 1,
      });

      const hasMore = events.length > limit;
      const page = hasMore ? events.slice(0, limit) : events;
      const last = page[page.length - 1];
      const nextCursor = hasMore && last ? encodeAuditCursor(last.sequence) : null;

      return { events: page, nextCursor };
    },
  );
}
