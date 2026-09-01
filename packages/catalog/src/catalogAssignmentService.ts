import { AUDIT_ACTIONS } from "@noahark/audit";
import {
  ConflictError,
  isAppError,
  NotFoundError,
  StaleVersionError,
  ValidationError,
  type AccessContext,
} from "@noahark/core";
import {
  assertHasLegalEntityAccess,
  requireExpectedVersion,
  requireNonEmptyLegalEntityScope,
  tenantContextInput,
} from "@noahark/core";
import { withTenantContext, type TransactionClient } from "@noahark/db";
import { auditActorFields, writeAuditEvent } from "./audit";
import { mapCatalogDbError, parseOrThrow } from "./errors";
import { lockCatalogItemAssignmentRow, lockCatalogItemAssignments } from "./locking";
import {
  CreateCatalogItemAssignmentSchema,
  ListCatalogItemAssignmentsSchema,
  UpdateCatalogItemAssignmentSchema,
} from "./schemas";

async function refuseLastActiveAssignment(
  tx: TransactionClient,
  tenantId: string,
  catalogItemId: string,
): Promise<void> {
  // `visibleActive` is an RLS-FILTERED LOWER BOUND on the true count.
  // The guard is sound BECAUSE it is a lower bound: RLS filters monotonically,
  // so visibleActive <= actualActive, and any state with actualActive <= 1
  // necessarily has visibleActive <= 1 and is refused. See ADR-77(c).
  const visibleActive = await tx.catalogItemLegalEntityAssignment.count({
    where: { tenantId, catalogItemId, status: "ACTIVE" },
  });
  if (visibleActive <= 1) {
    throw new ConflictError("A catalog item must keep at least one active assignment");
  }
}

export async function getCatalogItemAssignment(ctx: AccessContext, assignmentId: string) {
  requireNonEmptyLegalEntityScope(ctx);
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const row = await tx.catalogItemLegalEntityAssignment.findFirst({
      where: {
        id: assignmentId,
        tenantId: ctx.tenantId,
        legalEntityId: { in: Array.from(ctx.legalEntityIds) },
      },
    });
    if (!row) throw new NotFoundError("Assignment");
    return row;
  });
}

export async function listCatalogItemAssignments(ctx: AccessContext, raw: unknown = {}) {
  const input = parseOrThrow(ListCatalogItemAssignmentsSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  if (input.legalEntityId) {
    assertHasLegalEntityAccess(ctx, input.legalEntityId);
  }
  const entityFilter = input.legalEntityId
    ? [input.legalEntityId]
    : Array.from(ctx.legalEntityIds);
  return withTenantContext(tenantContextInput(ctx), (tx) =>
    tx.catalogItemLegalEntityAssignment.findMany({
      where: {
        tenantId: ctx.tenantId,
        legalEntityId: { in: entityFilter },
        ...(input.catalogItemId ? { catalogItemId: input.catalogItemId } : {}),
      },
      orderBy: { createdAt: "asc" },
    }),
  );
}

export async function createCatalogItemAssignment(ctx: AccessContext, raw: unknown) {
  const input = parseOrThrow(CreateCatalogItemAssignmentSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  assertHasLegalEntityAccess(ctx, input.legalEntityId);
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      await lockCatalogItemAssignments(tx, ctx.tenantId, input.catalogItemId);
      const item = await tx.catalogItem.findFirst({
        where: { id: input.catalogItemId, tenantId: ctx.tenantId },
      });
      if (!item) throw new NotFoundError("Catalog item");
      if (item.status === "ARCHIVED") {
        throw new ConflictError("Cannot assign an archived catalog item");
      }
      const assignment = await tx.catalogItemLegalEntityAssignment.create({
        data: {
          tenantId: ctx.tenantId,
          catalogItemId: input.catalogItemId,
          legalEntityId: input.legalEntityId,
          entityItemCode: input.entityItemCode ?? null,
        },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: assignment.legalEntityId,
        action: AUDIT_ACTIONS.CATALOG_ITEM_ASSIGNMENT_CREATED,
        entityType: "catalog_item_legal_entity_assignment",
        entityId: assignment.id,
        afterData: {
          id: assignment.id,
          catalogItemId: assignment.catalogItemId,
          legalEntityId: assignment.legalEntityId,
          status: assignment.status,
          version: assignment.version,
        },
      });
      return assignment;
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Assignment");
  }
}

export async function updateCatalogItemAssignment(
  ctx: AccessContext,
  assignmentId: string,
  raw: unknown,
) {
  const input = parseOrThrow(UpdateCatalogItemAssignmentSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Assignment");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const existing = await tx.catalogItemLegalEntityAssignment.findFirst({
        where: {
          id: assignmentId,
          tenantId: ctx.tenantId,
          legalEntityId: { in: Array.from(ctx.legalEntityIds) },
        },
      });
      if (!existing) throw new NotFoundError("Assignment");
      if (existing.status === "ARCHIVED") {
        throw new ValidationError("Archived assignments cannot be updated");
      }
      await lockCatalogItemAssignments(tx, ctx.tenantId, existing.catalogItemId);
      const locked = await lockCatalogItemAssignmentRow(tx, ctx.tenantId, assignmentId);
      if (!locked) throw new NotFoundError("Assignment");
      if (locked.version !== input.expectedVersion) {
        throw new StaleVersionError("Assignment");
      }
      if (input.status === "SUSPENDED" && locked.status === "ACTIVE") {
        await refuseLastActiveAssignment(tx, ctx.tenantId, locked.catalogItemId);
      }
      const updated = await tx.catalogItemLegalEntityAssignment.updateMany({
        where: {
          id: assignmentId,
          tenantId: ctx.tenantId,
          version: input.expectedVersion,
          legalEntityId: locked.legalEntityId,
        },
        data: {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.entityItemCode !== undefined
            ? { entityItemCode: input.entityItemCode }
            : {}),
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Assignment");
      const after = await tx.catalogItemLegalEntityAssignment.findFirstOrThrow({
        where: { id: assignmentId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: after.legalEntityId,
        action: AUDIT_ACTIONS.CATALOG_ITEM_ASSIGNMENT_UPDATED,
        entityType: "catalog_item_legal_entity_assignment",
        entityId: after.id,
        beforeData: { version: existing.version, status: existing.status },
        afterData: { version: after.version, status: after.status },
      });
      return after;
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Assignment");
  }
}

export async function archiveCatalogItemAssignment(
  ctx: AccessContext,
  assignmentId: string,
  expectedVersion: number,
) {
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(expectedVersion, "Assignment");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const existing = await tx.catalogItemLegalEntityAssignment.findFirst({
        where: {
          id: assignmentId,
          tenantId: ctx.tenantId,
          legalEntityId: { in: Array.from(ctx.legalEntityIds) },
        },
      });
      if (!existing) throw new NotFoundError("Assignment");
      if (existing.version !== expectedVersion) {
        throw new StaleVersionError("Assignment");
      }
      if (existing.status === "ARCHIVED") {
        throw new ValidationError("Assignment is already archived");
      }
      await lockCatalogItemAssignments(tx, ctx.tenantId, existing.catalogItemId);
      const locked = await lockCatalogItemAssignmentRow(tx, ctx.tenantId, assignmentId);
      if (!locked) throw new NotFoundError("Assignment");
      if (locked.status === "ACTIVE") {
        await refuseLastActiveAssignment(tx, ctx.tenantId, locked.catalogItemId);
      }
      const archivedAt = new Date();
      const updated = await tx.catalogItemLegalEntityAssignment.updateMany({
        where: {
          id: assignmentId,
          tenantId: ctx.tenantId,
          version: expectedVersion,
          legalEntityId: locked.legalEntityId,
        },
        data: {
          status: "ARCHIVED",
          archivedAt,
          version: { increment: 1 },
          updatedAt: archivedAt,
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Assignment");
      const after = await tx.catalogItemLegalEntityAssignment.findFirstOrThrow({
        where: { id: assignmentId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: after.legalEntityId,
        action: AUDIT_ACTIONS.CATALOG_ITEM_ASSIGNMENT_ARCHIVED,
        entityType: "catalog_item_legal_entity_assignment",
        entityId: after.id,
        beforeData: { version: existing.version, status: existing.status },
        afterData: { version: after.version, status: after.status },
      });
      return after;
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Assignment");
  }
}
