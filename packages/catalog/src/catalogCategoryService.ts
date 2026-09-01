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
import { lockCategoryRow } from "./locking";
import {
  CatalogCategoryIdVersionSchema,
  CreateCatalogCategorySchema,
  ListCatalogCategoriesSchema,
  UpdateCatalogCategorySchema,
} from "./schemas";
import { normaliseSearchTerm } from "./search";

function rejectImmutableCode(raw: unknown): void {
  if (raw !== null && typeof raw === "object" && "code" in raw) {
    throw new ValidationError("Category code is immutable");
  }
}

export async function createCatalogCategory(ctx: AccessContext, raw: unknown) {
  const input = parseOrThrow(CreateCatalogCategorySchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const row = await tx.catalogCategory.create({
        data: {
          tenantId: ctx.tenantId,
          code: input.code,
          name: input.name,
        },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: null,
        action: AUDIT_ACTIONS.CATALOG_CATEGORY_CREATED,
        entityType: "catalog_category",
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
    mapCatalogDbError(error, "Category");
  }
}

export async function getCatalogCategory(ctx: AccessContext, categoryId: string) {
  requireNonEmptyLegalEntityScope(ctx);
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const row = await tx.catalogCategory.findFirst({
      where: { id: categoryId, tenantId: ctx.tenantId },
    });
    if (!row) throw new NotFoundError("Category");
    return row;
  });
}

export async function listCatalogCategories(ctx: AccessContext, raw: unknown = {}) {
  const input = parseOrThrow(ListCatalogCategoriesSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  const limit = boundPageSize(input.limit);
  const cursor = input.cursor ? decodeCreatedAtIdCursor(input.cursor) : null;
  const isActive = input.isActive ?? true;
  const q = input.q ? normaliseSearchTerm(input.q) : "";
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const rows = await tx.catalogCategory.findMany({
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
      categories: page,
      nextCursor:
        hasMore && last ? encodeCreatedAtIdCursor(last.createdAt, last.id) : null,
    };
  });
}

export async function updateCatalogCategory(
  ctx: AccessContext,
  categoryId: string,
  raw: unknown,
) {
  rejectImmutableCode(raw);
  const input = parseOrThrow(UpdateCatalogCategorySchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Category");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const before = await tx.catalogCategory.findFirst({
        where: { id: categoryId, tenantId: ctx.tenantId },
      });
      if (!before) throw new NotFoundError("Category");
      const locked = await lockCategoryRow(tx, ctx.tenantId, categoryId);
      if (!locked) throw new NotFoundError("Category");
      if (locked.version !== input.expectedVersion) {
        throw new StaleVersionError("Category");
      }
      const updated = await tx.catalogCategory.updateMany({
        where: {
          id: categoryId,
          tenantId: ctx.tenantId,
          version: input.expectedVersion,
        },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Category");
      const after = await tx.catalogCategory.findFirstOrThrow({
        where: { id: categoryId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: null,
        action: AUDIT_ACTIONS.CATALOG_CATEGORY_UPDATED,
        entityType: "catalog_category",
        entityId: after.id,
        beforeData: { version: before.version, name: before.name },
        afterData: { version: after.version, name: after.name },
      });
      return after;
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Category");
  }
}

/**
 * isActive = false means unavailable for newly introduced or changed
 * CatalogItem references (1-A). Existing items that already reference this
 * row remain valid, readable and updatable. No reference-count query is
 * performed: a truthful count would require complete legal-entity scope
 * (ADR-77). Deactivating a category still used by another legal entity's
 * items is therefore permitted.
 */
export async function deactivateCatalogCategory(
  ctx: AccessContext,
  categoryId: string,
  raw: unknown,
) {
  const input = parseOrThrow(CatalogCategoryIdVersionSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Category");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const before = await tx.catalogCategory.findFirst({
        where: { id: categoryId, tenantId: ctx.tenantId },
      });
      if (!before) throw new NotFoundError("Category");
      const locked = await lockCategoryRow(tx, ctx.tenantId, categoryId);
      if (!locked) throw new NotFoundError("Category");
      if (locked.version !== input.expectedVersion) {
        throw new StaleVersionError("Category");
      }
      if (!locked.isActive) {
        throw new ValidationError("Category is already inactive");
      }
      const updated = await tx.catalogCategory.updateMany({
        where: {
          id: categoryId,
          tenantId: ctx.tenantId,
          version: input.expectedVersion,
        },
        data: {
          isActive: false,
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Category");
      const after = await tx.catalogCategory.findFirstOrThrow({
        where: { id: categoryId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: null,
        action: AUDIT_ACTIONS.CATALOG_CATEGORY_DEACTIVATED,
        entityType: "catalog_category",
        entityId: after.id,
        beforeData: { version: before.version, isActive: before.isActive },
        afterData: { version: after.version, isActive: after.isActive },
      });
      return after;
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Category");
  }
}

export async function activateCatalogCategory(
  ctx: AccessContext,
  categoryId: string,
  raw: unknown,
) {
  const input = parseOrThrow(CatalogCategoryIdVersionSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Category");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const before = await tx.catalogCategory.findFirst({
        where: { id: categoryId, tenantId: ctx.tenantId },
      });
      if (!before) throw new NotFoundError("Category");
      const locked = await lockCategoryRow(tx, ctx.tenantId, categoryId);
      if (!locked) throw new NotFoundError("Category");
      if (locked.version !== input.expectedVersion) {
        throw new StaleVersionError("Category");
      }
      if (locked.isActive) {
        throw new ValidationError("Category is already active");
      }
      const updated = await tx.catalogCategory.updateMany({
        where: {
          id: categoryId,
          tenantId: ctx.tenantId,
          version: input.expectedVersion,
        },
        data: {
          isActive: true,
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Category");
      const after = await tx.catalogCategory.findFirstOrThrow({
        where: { id: categoryId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: null,
        action: AUDIT_ACTIONS.CATALOG_CATEGORY_ACTIVATED,
        entityType: "catalog_category",
        entityId: after.id,
        beforeData: { version: before.version, isActive: before.isActive },
        afterData: { version: after.version, isActive: after.isActive },
      });
      return after;
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Category");
  }
}
