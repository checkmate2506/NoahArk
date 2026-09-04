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
import {
  lockPriceListAssignmentRow,
  lockPriceListAssignments,
  lockPriceListDefault,
  type LockedPriceListAssignmentRow,
} from "./pricingLocking";
import {
  CreatePriceListAssignmentSchema,
  ListPriceListAssignmentsSchema,
  SetDefaultPriceListSchema,
  UpdatePriceListAssignmentSchema,
} from "./pricingSchemas";

async function refuseLastActivePriceListAssignment(
  tx: TransactionClient,
  tenantId: string,
  priceListId: string,
): Promise<void> {
  const visibleActive = await tx.priceListLegalEntityAssignment.count({
    where: { tenantId, priceListId, status: "ACTIVE" },
  });
  if (visibleActive <= 1) {
    throw new ConflictError("A price list must keep at least one active assignment");
  }
}

async function stampNow(tx: TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT CLOCK_TIMESTAMP() AS now`;
  const now = rows[0]?.now;
  if (!now) throw new ValidationError("Could not read transaction timestamp");
  return now;
}

export async function getPriceListAssignment(ctx: AccessContext, assignmentId: string) {
  requireNonEmptyLegalEntityScope(ctx);
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const row = await tx.priceListLegalEntityAssignment.findFirst({
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

export async function listPriceListAssignments(ctx: AccessContext, raw: unknown = {}) {
  const input = parseOrThrow(ListPriceListAssignmentsSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  if (input.legalEntityId) {
    assertHasLegalEntityAccess(ctx, input.legalEntityId);
  }
  const entityFilter = input.legalEntityId
    ? [input.legalEntityId]
    : Array.from(ctx.legalEntityIds);
  return withTenantContext(tenantContextInput(ctx), (tx) =>
    tx.priceListLegalEntityAssignment.findMany({
      where: {
        tenantId: ctx.tenantId,
        legalEntityId: { in: entityFilter },
        ...(input.priceListId ? { priceListId: input.priceListId } : {}),
      },
      orderBy: { createdAt: "asc" },
    }),
  );
}

export async function createPriceListAssignment(ctx: AccessContext, raw: unknown) {
  const input = parseOrThrow(CreatePriceListAssignmentSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  assertHasLegalEntityAccess(ctx, input.legalEntityId);
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      await lockPriceListAssignments(tx, ctx.tenantId, input.priceListId);
      const priceList = await tx.priceList.findFirst({
        where: { id: input.priceListId, tenantId: ctx.tenantId },
      });
      if (!priceList) throw new NotFoundError("Price list");
      if (priceList.status === "ARCHIVED") {
        throw new ConflictError("Cannot assign an archived price list");
      }
      const assignment = await tx.priceListLegalEntityAssignment.create({
        data: {
          tenantId: ctx.tenantId,
          priceListId: input.priceListId,
          legalEntityId: input.legalEntityId,
          isDefault: false,
        },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: assignment.legalEntityId,
        action: AUDIT_ACTIONS.PRICE_LIST_ASSIGNMENT_CREATED,
        entityType: "price_list_legal_entity_assignment",
        entityId: assignment.id,
        afterData: {
          id: assignment.id,
          priceListId: assignment.priceListId,
          legalEntityId: assignment.legalEntityId,
          isDefault: assignment.isDefault,
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

export async function updatePriceListAssignment(
  ctx: AccessContext,
  assignmentId: string,
  raw: unknown,
) {
  const input = parseOrThrow(UpdatePriceListAssignmentSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Assignment");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const existing = await tx.priceListLegalEntityAssignment.findFirst({
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
      await lockPriceListDefault(tx, ctx.tenantId, existing.legalEntityId);
      await lockPriceListAssignments(tx, ctx.tenantId, existing.priceListId);
      const locked = await lockPriceListAssignmentRow(tx, ctx.tenantId, assignmentId);
      if (!locked) throw new NotFoundError("Assignment");
      if (locked.version !== input.expectedVersion) {
        throw new StaleVersionError("Assignment");
      }
      if (input.status === "SUSPENDED" && locked.status === "ACTIVE") {
        await refuseLastActivePriceListAssignment(tx, ctx.tenantId, locked.priceListId);
      }
      const resultingStatus = input.status ?? locked.status;
      const updated = await tx.priceListLegalEntityAssignment.updateMany({
        where: {
          id: assignmentId,
          tenantId: ctx.tenantId,
          version: input.expectedVersion,
          legalEntityId: locked.legalEntityId,
        },
        data: {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(resultingStatus !== "ACTIVE" ? { isDefault: false } : {}),
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Assignment");
      const after = await tx.priceListLegalEntityAssignment.findFirstOrThrow({
        where: { id: assignmentId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: after.legalEntityId,
        action: AUDIT_ACTIONS.PRICE_LIST_ASSIGNMENT_UPDATED,
        entityType: "price_list_legal_entity_assignment",
        entityId: after.id,
        beforeData: {
          version: existing.version,
          status: existing.status,
          isDefault: existing.isDefault,
        },
        afterData: {
          version: after.version,
          status: after.status,
          isDefault: after.isDefault,
        },
      });
      return after;
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Assignment");
  }
}

export async function archivePriceListAssignment(
  ctx: AccessContext,
  assignmentId: string,
  expectedVersion: number,
) {
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(expectedVersion, "Assignment");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const existing = await tx.priceListLegalEntityAssignment.findFirst({
        where: {
          id: assignmentId,
          tenantId: ctx.tenantId,
          legalEntityId: { in: Array.from(ctx.legalEntityIds) },
        },
      });
      if (!existing) throw new NotFoundError("Assignment");
      if (existing.status === "ARCHIVED") {
        throw new ValidationError("Assignment is already archived");
      }
      await lockPriceListDefault(tx, ctx.tenantId, existing.legalEntityId);
      await lockPriceListAssignments(tx, ctx.tenantId, existing.priceListId);
      const locked = await lockPriceListAssignmentRow(tx, ctx.tenantId, assignmentId);
      if (!locked) throw new NotFoundError("Assignment");
      if (locked.version !== expectedVersion) {
        throw new StaleVersionError("Assignment");
      }
      if (locked.status === "ACTIVE") {
        await refuseLastActivePriceListAssignment(tx, ctx.tenantId, locked.priceListId);
      }
      const archivedAt = await stampNow(tx);
      const updated = await tx.priceListLegalEntityAssignment.updateMany({
        where: {
          id: assignmentId,
          tenantId: ctx.tenantId,
          version: expectedVersion,
          legalEntityId: locked.legalEntityId,
        },
        data: {
          status: "ARCHIVED",
          archivedAt,
          isDefault: false,
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Assignment");
      const after = await tx.priceListLegalEntityAssignment.findFirstOrThrow({
        where: { id: assignmentId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: after.legalEntityId,
        action: AUDIT_ACTIONS.PRICE_LIST_ASSIGNMENT_ARCHIVED,
        entityType: "price_list_legal_entity_assignment",
        entityId: after.id,
        beforeData: {
          version: existing.version,
          status: existing.status,
          isDefault: existing.isDefault,
        },
        afterData: {
          version: after.version,
          status: after.status,
          isDefault: after.isDefault,
        },
      });
      return after;
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Assignment");
  }
}

export async function setDefaultPriceList(ctx: AccessContext, raw: unknown) {
  const input = parseOrThrow(SetDefaultPriceListSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  assertHasLegalEntityAccess(ctx, input.legalEntityId);
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      await lockPriceListDefault(tx, ctx.tenantId, input.legalEntityId);

      const incumbent = await tx.priceListLegalEntityAssignment.findFirst({
        where: {
          tenantId: ctx.tenantId,
          legalEntityId: input.legalEntityId,
          isDefault: true,
          status: "ACTIVE",
        },
      });
      const target =
        input.priceListId === null
          ? null
          : await tx.priceListLegalEntityAssignment.findFirst({
              where: {
                tenantId: ctx.tenantId,
                priceListId: input.priceListId,
                legalEntityId: input.legalEntityId,
              },
            });

      if (input.priceListId !== null && !target) {
        throw new NotFoundError("Assignment");
      }

      if (input.priceListId === null && !incumbent) {
        throw new ValidationError("That legal entity has no default price list");
      }
      if (
        input.priceListId !== null &&
        incumbent &&
        incumbent.priceListId === input.priceListId &&
        incumbent.status === "ACTIVE"
      ) {
        throw new ValidationError("That price list is already the default");
      }

      const affectedIds = new Set<string>();
      if (incumbent) affectedIds.add(incumbent.priceListId);
      if (target) affectedIds.add(target.priceListId);
      const sortedIds = Array.from(affectedIds).sort();
      for (const priceListId of sortedIds) {
        await lockPriceListAssignments(tx, ctx.tenantId, priceListId);
      }

      const toLock = [incumbent, target].filter(
        (row, index, rows): row is NonNullable<typeof row> =>
          row !== null && rows.findIndex((other) => other?.id === row.id) === index,
      );
      toLock.sort((a, b) => {
        if (a.priceListId < b.priceListId) return -1;
        if (a.priceListId > b.priceListId) return 1;
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
      });
      const lockedById = new Map<string, LockedPriceListAssignmentRow>();
      for (const row of toLock) {
        const locked = await lockPriceListAssignmentRow(tx, ctx.tenantId, row.id);
        if (!locked) throw new NotFoundError("Assignment");
        lockedById.set(row.id, locked);
      }

      const lockedIncumbent = incumbent ? lockedById.get(incumbent.id) : undefined;
      const lockedTarget = target ? lockedById.get(target.id) : undefined;
      if (incumbent && !lockedIncumbent) throw new NotFoundError("Assignment");
      if (target && !lockedTarget) throw new NotFoundError("Assignment");
      if (incumbent && lockedIncumbent) {
        if (
          lockedIncumbent.priceListId !== incumbent.priceListId ||
          lockedIncumbent.legalEntityId !== input.legalEntityId
        ) {
          throw new ConflictError("Default price list changed concurrently");
        }
      }
      if (target && lockedTarget) {
        if (
          lockedTarget.priceListId !== target.priceListId ||
          lockedTarget.legalEntityId !== input.legalEntityId
        ) {
          throw new ConflictError("Default price list changed concurrently");
        }
        if (lockedTarget.status !== "ACTIVE") {
          throw new ConflictError("Assignment is not active");
        }
        const master = await tx.priceList.findFirst({
          where: { id: lockedTarget.priceListId, tenantId: ctx.tenantId },
        });
        if (!master || master.status !== "ACTIVE") {
          throw new ConflictError("Price list is not active");
        }
      }
      if (!ctx.legalEntityIds.has(input.legalEntityId)) {
        throw new NotFoundError("Assignment");
      }

      if (input.priceListId === null && !lockedIncumbent) {
        throw new ValidationError("That legal entity has no default price list");
      }
      if (
        input.priceListId !== null &&
        lockedIncumbent &&
        lockedIncumbent.priceListId === input.priceListId &&
        lockedIncumbent.status === "ACTIVE" &&
        lockedIncumbent.isDefault
      ) {
        throw new ValidationError("That price list is already the default");
      }

      const previousPriceListId = lockedIncumbent?.isDefault
        ? lockedIncumbent.priceListId
        : null;
      const nextPriceListId = input.priceListId;

      if (
        lockedIncumbent &&
        lockedTarget &&
        lockedIncumbent.id !== lockedTarget.id &&
        lockedIncumbent.isDefault
      ) {
        const cleared = await tx.priceListLegalEntityAssignment.updateMany({
          where: {
            id: lockedIncumbent.id,
            tenantId: ctx.tenantId,
            version: lockedIncumbent.version,
            legalEntityId: lockedIncumbent.legalEntityId,
          },
          data: { isDefault: false, version: { increment: 1 } },
        });
        if (cleared.count === 0) throw new StaleVersionError("Assignment");
      } else if (lockedIncumbent && nextPriceListId === null) {
        const cleared = await tx.priceListLegalEntityAssignment.updateMany({
          where: {
            id: lockedIncumbent.id,
            tenantId: ctx.tenantId,
            version: lockedIncumbent.version,
            legalEntityId: lockedIncumbent.legalEntityId,
          },
          data: { isDefault: false, version: { increment: 1 } },
        });
        if (cleared.count === 0) throw new StaleVersionError("Assignment");
      }

      if (lockedTarget && nextPriceListId !== null) {
        const set = await tx.priceListLegalEntityAssignment.updateMany({
          where: {
            id: lockedTarget.id,
            tenantId: ctx.tenantId,
            version: lockedTarget.version,
            legalEntityId: lockedTarget.legalEntityId,
          },
          data: { isDefault: true, version: { increment: 1 } },
        });
        if (set.count === 0) throw new StaleVersionError("Assignment");
      }

      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: input.legalEntityId,
        action: AUDIT_ACTIONS.PRICE_LIST_DEFAULT_CHANGED,
        entityType: "price_list_legal_entity_assignment",
        entityId: (lockedTarget ?? lockedIncumbent)?.id ?? input.legalEntityId,
        beforeData: { priceListId: previousPriceListId },
        afterData: { priceListId: nextPriceListId },
      });

      return {
        legalEntityId: input.legalEntityId,
        previousPriceListId,
        priceListId: nextPriceListId,
      };
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Assignment");
  }
}
