import { writeAuditEventInTx, type TransactionClient } from "@noahark/db";
import type { AuditEventInput } from "@noahark/audit";

export async function writeAuditEvent(tx: TransactionClient, input: AuditEventInput) {
  return writeAuditEventInTx(tx, input);
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
