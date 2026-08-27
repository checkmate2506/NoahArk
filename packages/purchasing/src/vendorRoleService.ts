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
import {
  assertHasLegalEntityAccess,
  auditActorFields,
  insertVendorRole,
  mapPartyDbError,
  requireExpectedVersion,
  requireNonEmptyLegalEntityScope,
  tenantContextInput,
  writeAuditEvent,
} from "@noahark/crm";

export const CreateVendorRoleSchema = z.object({
  assignmentId: z.string().min(1).max(64),
  code: z.string().trim().min(1).max(64),
  defaultCurrency: z.enum(CURRENCIES).optional(),
});

export const UpdateVendorRoleSchema = z.object({
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

export async function createVendorRole(ctx: AccessContext, raw: unknown) {
  const input = parseOrThrow(CreateVendorRoleSchema, raw);
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
      return insertVendorRole(tx, ctx, {
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
    mapPartyDbError(error, "VendorRole");
  }
}

export async function getVendorRole(ctx: AccessContext, roleId: string) {
  requireNonEmptyLegalEntityScope(ctx);
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const role = await tx.vendorRole.findFirst({
      where: {
        id: roleId,
        tenantId: ctx.tenantId,
        legalEntityId: { in: Array.from(ctx.legalEntityIds) },
      },
    });
    if (!role) throw new NotFoundError("VendorRole");
    return role;
  });
}

export async function updateVendorRole(ctx: AccessContext, roleId: string, raw: unknown) {
  const input = parseOrThrow(UpdateVendorRoleSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "VendorRole");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const existing = await tx.vendorRole.findFirst({
        where: {
          id: roleId,
          tenantId: ctx.tenantId,
          legalEntityId: { in: Array.from(ctx.legalEntityIds) },
        },
      });
      if (!existing) throw new NotFoundError("VendorRole");
      if (existing.version !== input.expectedVersion) {
        throw new StaleVersionError("VendorRole");
      }
      if (existing.status === "ARCHIVED") {
        throw new ValidationError("Archived vendor roles cannot be updated");
      }
      const updated = await tx.vendorRole.updateMany({
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
      if (updated.count === 0) throw new StaleVersionError("VendorRole");
      const after = await tx.vendorRole.findFirstOrThrow({
        where: { id: roleId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: after.legalEntityId,
        action: AUDIT_ACTIONS.VENDOR_ROLE_UPDATED,
        entityType: "vendor_role",
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
    mapPartyDbError(error, "VendorRole");
  }
}

export async function archiveVendorRole(
  ctx: AccessContext,
  roleId: string,
  expectedVersion: number,
) {
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(expectedVersion, "VendorRole");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const existing = await tx.vendorRole.findFirst({
        where: {
          id: roleId,
          tenantId: ctx.tenantId,
          legalEntityId: { in: Array.from(ctx.legalEntityIds) },
        },
      });
      if (!existing) throw new NotFoundError("VendorRole");
      if (existing.version !== expectedVersion) {
        throw new StaleVersionError("VendorRole");
      }
      if (existing.status === "ARCHIVED") {
        throw new ValidationError("Vendor role is already archived");
      }
      const archivedAt = new Date();
      const updated = await tx.vendorRole.updateMany({
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
      if (updated.count === 0) throw new StaleVersionError("VendorRole");
      const after = await tx.vendorRole.findFirstOrThrow({
        where: { id: roleId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: after.legalEntityId,
        action: AUDIT_ACTIONS.VENDOR_ROLE_ARCHIVED,
        entityType: "vendor_role",
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
    mapPartyDbError(error, "VendorRole");
  }
}
