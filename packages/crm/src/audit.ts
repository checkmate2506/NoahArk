import { Prisma, type TransactionClient } from "@noahark/db";
import {
  buildAuditEventRow,
  chainKeyForTenant,
  type AuditEventInput,
} from "@noahark/audit";

/**
 * Same-transaction hash-chained audit write. Mirrors the Phase 1 writer in
 * apps/web so domain packages never import the Next.js app. Advisory lock
 * + sequence DESC keeps the chain gap-free under concurrency.
 */
export async function writeAuditEvent(tx: TransactionClient, input: AuditEventInput) {
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

export type PartyAuditActor = {
  tenantId: string;
  userId: string;
  requestId: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
};

export function auditActorFields(ctx: PartyAuditActor) {
  return {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    requestId: ctx.requestId,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  };
}
