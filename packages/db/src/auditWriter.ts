import {
  buildAuditEventRow,
  chainKeyForTenant,
  type AuditEventInput,
} from "@noahark/audit";
import { Prisma, type AuditEvent, type TransactionClient } from "./client";

export type { AuditEventInput };

/**
 * Single transactional audit persistence writer for the monorepo (ADR-76).
 * Receives the caller's existing TransactionClient — never constructs a
 * client, never opens its own transaction, never reaches system/worker
 * clients. Mapping is the captured Phase 1 / P2B persistence contract:
 * advisory lock on chainKey, predecessor by sequence DESC, JsonNull for
 * JSON-null columns.
 */
export async function writeAuditEventInTx(
  tx: TransactionClient,
  input: AuditEventInput,
): Promise<AuditEvent> {
  const chainKey = chainKeyForTenant(input.tenantId ?? null);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${chainKey}))`;

  const latest = await tx.auditEvent.findFirst({
    where: { chainKey },
    orderBy: { sequence: "desc" },
    select: { hash: true, sequence: true },
  });

  const nextSequence = (latest?.sequence ?? 0n) + 1n;
  const row = buildAuditEventRow(input, latest?.hash ?? null, nextSequence);

  return tx.auditEvent.create({
    data: {
      tenantId: row.tenantId,
      legalEntityId: row.legalEntityId,
      actorUserId: row.actorUserId,
      actorType: row.actorType,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      beforeData:
        row.beforeData === null
          ? Prisma.JsonNull
          : (row.beforeData as Prisma.InputJsonValue),
      afterData:
        row.afterData === null
          ? Prisma.JsonNull
          : (row.afterData as Prisma.InputJsonValue),
      requestId: row.requestId,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      outcome: row.outcome,
      chainKey: row.chainKey,
      sequence: row.sequence,
      prevHash: row.prevHash,
      hash: row.hash,
      createdAt: row.createdAt,
    },
  });
}
