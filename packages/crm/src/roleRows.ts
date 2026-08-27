import { AUDIT_ACTIONS } from "@noahark/audit";
import type { AccessContext } from "@noahark/core";
import type { Currency, TransactionClient } from "@noahark/db";
import { writeAuditEvent, auditActorFields } from "./audit";

export async function insertCustomerRole(
  tx: TransactionClient,
  ctx: AccessContext,
  input: {
    assignmentId: string;
    legalEntityId: string;
    code: string;
    defaultCurrency?: Currency | undefined;
  },
) {
  const role = await tx.customerRole.create({
    data: {
      tenantId: ctx.tenantId,
      legalEntityId: input.legalEntityId,
      assignmentId: input.assignmentId,
      code: input.code.trim(),
      ...(input.defaultCurrency !== undefined
        ? { defaultCurrency: input.defaultCurrency }
        : {}),
    },
  });
  await writeAuditEvent(tx, {
    ...auditActorFields(ctx),
    legalEntityId: input.legalEntityId,
    action: AUDIT_ACTIONS.CUSTOMER_ROLE_CREATED,
    entityType: "customer_role",
    entityId: role.id,
    afterData: {
      id: role.id,
      assignmentId: role.assignmentId,
      legalEntityId: role.legalEntityId,
      code: role.code,
      version: role.version,
    },
  });
  return role;
}

export async function insertVendorRole(
  tx: TransactionClient,
  ctx: AccessContext,
  input: {
    assignmentId: string;
    legalEntityId: string;
    code: string;
    defaultCurrency?: Currency | undefined;
  },
) {
  const role = await tx.vendorRole.create({
    data: {
      tenantId: ctx.tenantId,
      legalEntityId: input.legalEntityId,
      assignmentId: input.assignmentId,
      code: input.code.trim(),
      ...(input.defaultCurrency !== undefined
        ? { defaultCurrency: input.defaultCurrency }
        : {}),
    },
  });
  await writeAuditEvent(tx, {
    ...auditActorFields(ctx),
    legalEntityId: input.legalEntityId,
    action: AUDIT_ACTIONS.VENDOR_ROLE_CREATED,
    entityType: "vendor_role",
    entityId: role.id,
    afterData: {
      id: role.id,
      assignmentId: role.assignmentId,
      legalEntityId: role.legalEntityId,
      code: role.code,
      version: role.version,
    },
  });
  return role;
}
