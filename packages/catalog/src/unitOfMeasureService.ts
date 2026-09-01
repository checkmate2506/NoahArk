import { AUDIT_ACTIONS } from "@noahark/audit";
import {
  isAppError,
  NotFoundError,
  StaleVersionError,
  ValidationError,
  type AccessContext,
} from "@noahark/core";
import {
  boundPageSize,
  decodeCreatedAtIdCursor,
  encodeCreatedAtIdCursor,
  requireExpectedVersion,
  requireNonEmptyLegalEntityScope,
  tenantContextInput,
} from "@noahark/core";
import { withTenantContext } from "@noahark/db";
import { auditActorFields, writeAuditEvent } from "./audit";
import { mapCatalogDbError, parseOrThrow } from "./errors";
import { lockUnitOfMeasureRow } from "./locking";
import {
  CreateUnitOfMeasureSchema,
  ListUnitsOfMeasureSchema,
  UnitOfMeasureIdVersionSchema,
  UpdateUnitOfMeasureSchema,
} from "./schemas";
import { normaliseSearchTerm } from "./search";

function rejectImmutableCode(raw: unknown): void {
  if (raw !== null && typeof raw === "object" && "code" in raw) {
    throw new ValidationError("Unit of measure code is immutable");
  }
}

export async function createUnitOfMeasure(ctx: AccessContext, raw: unknown) {
  const input = parseOrThrow(CreateUnitOfMeasureSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const row = await tx.unitOfMeasure.create({
        data: {
          tenantId: ctx.tenantId,
          code: input.code,
          name: input.name,
        },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: null,
        action: AUDIT_ACTIONS.UNIT_OF_MEASURE_CREATED,
        entityType: "unit_of_measure",
        entityId: row.id,
        afterData: {
          id: row.id,
          code: row.code,
          name: row.name,
          isActive: row.isActive,
          version: row.version,
        },
      });
      return row;
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Unit of measure");
  }
}

export async function getUnitOfMeasure(ctx: AccessContext, uomId: string) {
  requireNonEmptyLegalEntityScope(ctx);
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const row = await tx.unitOfMeasure.findFirst({
      where: { id: uomId, tenantId: ctx.tenantId },
    });
    if (!row) throw new NotFoundError("Unit of measure");
    return row;
  });
}

export async function listUnitsOfMeasure(ctx: AccessContext, raw: unknown = {}) {
  const input = parseOrThrow(ListUnitsOfMeasureSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  const limit = boundPageSize(input.limit);
  const cursor = input.cursor ? decodeCreatedAtIdCursor(input.cursor) : null;
  const isActive = input.isActive ?? true;
  const q = input.q ? normaliseSearchTerm(input.q) : "";
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const rows = await tx.unitOfMeasure.findMany({
      where: {
        tenantId: ctx.tenantId,
        isActive,
        AND: [
          ...(q
            ? [
                {
                  OR: [
                    { code: { startsWith: q, mode: "insensitive" as const } },
                    { name: { startsWith: q, mode: "insensitive" as const } },
                  ],
                },
              ]
            : []),
          ...(cursor
            ? [
                {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      units: page,
      nextCursor:
        hasMore && last ? encodeCreatedAtIdCursor(last.createdAt, last.id) : null,
    };
  });
}

export async function updateUnitOfMeasure(
  ctx: AccessContext,
  uomId: string,
  raw: unknown,
) {
  rejectImmutableCode(raw);
  const input = parseOrThrow(UpdateUnitOfMeasureSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Unit of measure");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const before = await tx.unitOfMeasure.findFirst({
        where: { id: uomId, tenantId: ctx.tenantId },
      });
      if (!before) throw new NotFoundError("Unit of measure");
      const locked = await lockUnitOfMeasureRow(tx, ctx.tenantId, uomId);
      if (!locked) throw new NotFoundError("Unit of measure");
      if (locked.version !== input.expectedVersion) {
        throw new StaleVersionError("Unit of measure");
      }
      const updated = await tx.unitOfMeasure.updateMany({
        where: { id: uomId, tenantId: ctx.tenantId, version: input.expectedVersion },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Unit of measure");
      const after = await tx.unitOfMeasure.findFirstOrThrow({
        where: { id: uomId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: null,
        action: AUDIT_ACTIONS.UNIT_OF_MEASURE_UPDATED,
        entityType: "unit_of_measure",
        entityId: after.id,
        beforeData: { version: before.version, name: before.name },
        afterData: { version: after.version, name: after.name },
      });
      return after;
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Unit of measure");
  }
}

/**
 * isActive = false means unavailable for newly introduced or changed
 * CatalogItem references (1-A). Existing items that already reference this
 * row remain valid, readable and updatable. No reference-count query is
 * performed: a truthful count would require complete legal-entity scope
 * (ADR-77). Deactivating a UOM still used by another legal entity's items
 * is therefore permitted.
 */
export async function deactivateUnitOfMeasure(
  ctx: AccessContext,
  uomId: string,
  raw: unknown,
) {
  const input = parseOrThrow(UnitOfMeasureIdVersionSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Unit of measure");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const before = await tx.unitOfMeasure.findFirst({
        where: { id: uomId, tenantId: ctx.tenantId },
      });
      if (!before) throw new NotFoundError("Unit of measure");
      const locked = await lockUnitOfMeasureRow(tx, ctx.tenantId, uomId);
      if (!locked) throw new NotFoundError("Unit of measure");
      if (locked.version !== input.expectedVersion) {
        throw new StaleVersionError("Unit of measure");
      }
      if (!locked.isActive) {
        throw new ValidationError("Unit of measure is already inactive");
      }
      const updated = await tx.unitOfMeasure.updateMany({
        where: { id: uomId, tenantId: ctx.tenantId, version: input.expectedVersion },
        data: {
          isActive: false,
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Unit of measure");
      const after = await tx.unitOfMeasure.findFirstOrThrow({
        where: { id: uomId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: null,
        action: AUDIT_ACTIONS.UNIT_OF_MEASURE_DEACTIVATED,
        entityType: "unit_of_measure",
        entityId: after.id,
        beforeData: { version: before.version, isActive: before.isActive },
        afterData: { version: after.version, isActive: after.isActive },
      });
      return after;
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Unit of measure");
  }
}

export async function activateUnitOfMeasure(
  ctx: AccessContext,
  uomId: string,
  raw: unknown,
) {
  const input = parseOrThrow(UnitOfMeasureIdVersionSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Unit of measure");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const before = await tx.unitOfMeasure.findFirst({
        where: { id: uomId, tenantId: ctx.tenantId },
      });
      if (!before) throw new NotFoundError("Unit of measure");
      const locked = await lockUnitOfMeasureRow(tx, ctx.tenantId, uomId);
      if (!locked) throw new NotFoundError("Unit of measure");
      if (locked.version !== input.expectedVersion) {
        throw new StaleVersionError("Unit of measure");
      }
      if (locked.isActive) {
        throw new ValidationError("Unit of measure is already active");
      }
      const updated = await tx.unitOfMeasure.updateMany({
        where: { id: uomId, tenantId: ctx.tenantId, version: input.expectedVersion },
        data: {
          isActive: true,
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Unit of measure");
      const after = await tx.unitOfMeasure.findFirstOrThrow({
        where: { id: uomId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: null,
        action: AUDIT_ACTIONS.UNIT_OF_MEASURE_ACTIVATED,
        entityType: "unit_of_measure",
        entityId: after.id,
        beforeData: { version: before.version, isActive: before.isActive },
        afterData: { version: after.version, isActive: after.isActive },
      });
      return after;
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Unit of measure");
  }
}
