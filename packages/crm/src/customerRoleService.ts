import { z } from "zod";
import { AUDIT_ACTIONS } from "@noahark/audit";
import {
  ForbiddenError,
  NotFoundError,
  StaleVersionError,
  ValidationError,
  omitUndefined,
  CURRENCIES,
  type AccessContext,
} from "@noahark/core";
import { withTenantContext } from "@noahark/db";
import { writeAuditEvent, auditActorFields } from "./audit";
import { mapPartyDbError } from "./errors";
import { insertCustomerRole } from "./roleRows";
import {
  assertHasLegalEntityAccess,
  requireExpectedVersion,
  requireNonEmptyLegalEntityScope,
  tenantContextInput,
} from "./trustedContext";

export const CreateCustomerRoleSchema = z.object({
  assignmentId: z.string().min(1).max(64),
  code: z.string().trim().min(1).max(64),
  defaultCurrency: z.enum(CURRENCIES).optional(),
});

export const UpdateCustomerRoleSchema = z.object({
  expectedVersion: z.number().int().min(1),
  code: z.string().trim().min(1).max(64).optional(),
  defaultCurrency: z.enum(CURRENCIES).nullable().optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
});

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid input", { issues: parsed.error.issues });
  }
  return parsed.data;
}

export async function createCustomerRole(ctx: AccessContext, raw: unknown) {
  const input = parseOrThrow(CreateCustomerRoleSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const assignment = await tx.partyLegalEntityAssignment.findFirst({
        where: {
          id: input.assignmentId,
          tenantId: ctx.tenantId,
          legalEntityId: { in: Array.from(ctx.legalEntityIds) },
        },
      });
      if (!assignment) throw new NotFoundError("Assignment");
      assertHasLegalEntityAccess(ctx, assignment.legalEntityId);
      return insertCustomerRole(tx, ctx, {
        assignmentId: assignment.id,
        legalEntityId: assignment.legalEntityId,
        code: input.code,
        defaultCurrency: input.defaultCurrency,
      });
    });
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError
    ) {
      throw error;
    }
    mapPartyDbError(error, "CustomerRole");
  }
}

export async function getCustomerRole(ctx: AccessContext, roleId: string) {
  requireNonEmptyLegalEntityScope(ctx);
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const role = await tx.customerRole.findFirst({
      where: {
        id: roleId,
        tenantId: ctx.tenantId,
        legalEntityId: { in: Array.from(ctx.legalEntityIds) },
      },
    });
    if (!role) throw new NotFoundError("CustomerRole");
    return role;
  });
}

export async function updateCustomerRole(
  ctx: AccessContext,
  roleId: string,
  raw: unknown,
) {
  const input = parseOrThrow(UpdateCustomerRoleSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "CustomerRole");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const existing = await tx.customerRole.findFirst({
        where: {
          id: roleId,
          tenantId: ctx.tenantId,
          legalEntityId: { in: Array.from(ctx.legalEntityIds) },
        },
      });
      if (!existing) throw new NotFoundError("CustomerRole");
      if (existing.version !== input.expectedVersion) {
        throw new StaleVersionError("CustomerRole");
      }
      if (existing.status === "ARCHIVED") {
        throw new ValidationError("Archived customer roles cannot be updated");
      }
      const updated = await tx.customerRole.updateMany({
        where: {
          id: roleId,
          tenantId: ctx.tenantId,
          version: input.expectedVersion,
          legalEntityId: existing.legalEntityId,
        },
        data: {
          ...omitUndefined({
            code: input.code,
            status: input.status,
          }),
          ...(input.defaultCurrency !== undefined
            ? { defaultCurrency: input.defaultCurrency }
            : {}),
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (updated.count === 0) throw new StaleVersionError("CustomerRole");
      const after = await tx.customerRole.findFirstOrThrow({
        where: { id: roleId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: after.legalEntityId,
        action: AUDIT_ACTIONS.CUSTOMER_ROLE_UPDATED,
        entityType: "customer_role",
        entityId: after.id,
        beforeData: { version: existing.version, code: existing.code },
        afterData: { version: after.version, code: after.code },
      });
      return after;
    });
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError ||
      error instanceof StaleVersionError
    ) {
      throw error;
    }
    mapPartyDbError(error, "CustomerRole");
  }
}

export async function archiveCustomerRole(
  ctx: AccessContext,
  roleId: string,
  expectedVersion: number,
) {
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(expectedVersion, "CustomerRole");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const existing = await tx.customerRole.findFirst({
        where: {
          id: roleId,
          tenantId: ctx.tenantId,
          legalEntityId: { in: Array.from(ctx.legalEntityIds) },
        },
      });
      if (!existing) throw new NotFoundError("CustomerRole");
      if (existing.version !== expectedVersion) {
        throw new StaleVersionError("CustomerRole");
      }
      if (existing.status === "ARCHIVED") {
        throw new ValidationError("Customer role is already archived");
      }
      const archivedAt = new Date();
      const updated = await tx.customerRole.updateMany({
        where: {
          id: roleId,
          tenantId: ctx.tenantId,
          version: expectedVersion,
          legalEntityId: existing.legalEntityId,
        },
        data: {
          status: "ARCHIVED",
          archivedAt,
          version: { increment: 1 },
          updatedAt: archivedAt,
        },
      });
      if (updated.count === 0) throw new StaleVersionError("CustomerRole");
      const after = await tx.customerRole.findFirstOrThrow({
        where: { id: roleId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: after.legalEntityId,
        action: AUDIT_ACTIONS.CUSTOMER_ROLE_ARCHIVED,
        entityType: "customer_role",
        entityId: after.id,
        beforeData: { version: existing.version, status: existing.status },
        afterData: { version: after.version, status: after.status },
      });
      return after;
    });
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError ||
      error instanceof StaleVersionError
    ) {
      throw error;
    }
    mapPartyDbError(error, "CustomerRole");
  }
}
