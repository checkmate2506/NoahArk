import { AUDIT_ACTIONS } from "@noahark/audit";
import {
  ForbiddenError,
  isAppError,
  NotFoundError,
  StaleVersionError,
  ValidationError,
  omitUndefined,
  type AccessContext,
} from "@noahark/core";
import {
  assertHasLegalEntityAccess,
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
import {
  lockCatalogItemAssignments,
  lockCatalogItemRow,
  requireActiveCategoryForShare,
  requireActiveUomForShare,
} from "./locking";
import {
  CreateCatalogItemSchema,
  ListCatalogItemsSchema,
  TransferCatalogItemOwnershipSchema,
  UpdateCatalogItemSchema,
} from "./schemas";
import { normaliseSearchTerm } from "./search";

function canMutateOwner(ctx: AccessContext, ownerLegalEntityId: string): boolean {
  return ctx.legalEntityIds.has(ownerLegalEntityId);
}

export async function createCatalogItem(ctx: AccessContext, raw: unknown) {
  const input = parseOrThrow(CreateCatalogItemSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  assertHasLegalEntityAccess(ctx, input.ownerLegalEntityId);
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      // No catalog-item-assignments advisory lock: the item id does not exist
      // before this transaction, so no concurrent writer can contend on
      // catalog-item-assignments:<tenantId>:<newId>.
      if (input.categoryId) {
        await requireActiveCategoryForShare(tx, ctx.tenantId, input.categoryId);
      }
      await requireActiveUomForShare(tx, ctx.tenantId, input.baseUomId);

      const item = await tx.catalogItem.create({
        data: {
          tenantId: ctx.tenantId,
          ownerLegalEntityId: input.ownerLegalEntityId,
          code: input.code,
          itemType: input.itemType,
          name: input.name,
          description: input.description ?? null,
          categoryId: input.categoryId ?? null,
          baseUomId: input.baseUomId,
          taxCategoryCode: input.taxCategoryCode ?? null,
          isSellable: input.isSellable ?? true,
          isPurchasable: input.isPurchasable ?? true,
        },
      });
      const assignment = await tx.catalogItemLegalEntityAssignment.create({
        data: {
          tenantId: ctx.tenantId,
          catalogItemId: item.id,
          legalEntityId: input.ownerLegalEntityId,
          entityItemCode: input.entityItemCode ?? null,
        },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: item.ownerLegalEntityId,
        action: AUDIT_ACTIONS.CATALOG_ITEM_CREATED,
        entityType: "catalog_item",
        entityId: item.id,
        afterData: {
          id: item.id,
          code: item.code,
          itemType: item.itemType,
          ownerLegalEntityId: item.ownerLegalEntityId,
          status: item.status,
          version: item.version,
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
      return { item, assignment };
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Catalog item");
  }
}

export async function getCatalogItem(ctx: AccessContext, catalogItemId: string) {
  requireNonEmptyLegalEntityScope(ctx);
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const item = await tx.catalogItem.findFirst({
      where: { id: catalogItemId, tenantId: ctx.tenantId },
    });
    if (!item) throw new NotFoundError("Catalog item");
    return item;
  });
}

export async function listCatalogItems(ctx: AccessContext, raw: unknown = {}) {
  const input = parseOrThrow(ListCatalogItemsSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  const limit = boundPageSize(input.limit);
  const cursor = input.cursor ? decodeCreatedAtIdCursor(input.cursor) : null;
  const status = input.status ?? (input.includeArchived ? undefined : "ACTIVE");
  const q = input.q ? normaliseSearchTerm(input.q) : "";
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const rows = await tx.catalogItem.findMany({
      where: {
        tenantId: ctx.tenantId,
        ...(status ? { status } : {}),
        ...(input.itemType ? { itemType: input.itemType } : {}),
        ...(input.categoryId ? { categoryId: input.categoryId } : {}),
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
      items: page,
      nextCursor:
        hasMore && last ? encodeCreatedAtIdCursor(last.createdAt, last.id) : null,
    };
  });
}

export async function updateCatalogItem(
  ctx: AccessContext,
  catalogItemId: string,
  raw: unknown,
) {
  const input = parseOrThrow(UpdateCatalogItemSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Catalog item");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const before = await tx.catalogItem.findFirst({
        where: { id: catalogItemId, tenantId: ctx.tenantId },
      });
      if (!before) throw new NotFoundError("Catalog item");
      if (!canMutateOwner(ctx, before.ownerLegalEntityId)) {
        throw new ForbiddenError("Not permitted");
      }
      const locked = await lockCatalogItemRow(tx, ctx.tenantId, catalogItemId);
      if (!locked) throw new NotFoundError("Catalog item");
      if (locked.version !== input.expectedVersion) {
        throw new StaleVersionError("Catalog item");
      }
      if (locked.status === "ARCHIVED") {
        throw new ValidationError("Archived catalog items cannot be updated");
      }

      if (
        input.categoryId !== undefined &&
        input.categoryId !== null &&
        input.categoryId !== locked.categoryId
      ) {
        await requireActiveCategoryForShare(tx, ctx.tenantId, input.categoryId);
      }
      if (input.baseUomId !== undefined && input.baseUomId !== locked.baseUomId) {
        await requireActiveUomForShare(tx, ctx.tenantId, input.baseUomId);
      }

      const updated = await tx.catalogItem.updateMany({
        where: {
          id: catalogItemId,
          tenantId: ctx.tenantId,
          version: input.expectedVersion,
        },
        data: {
          ...omitUndefined({
            code: input.code,
            name: input.name,
            baseUomId: input.baseUomId,
            isSellable: input.isSellable,
            isPurchasable: input.isPurchasable,
          }),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          ...(input.taxCategoryCode !== undefined
            ? { taxCategoryCode: input.taxCategoryCode }
            : {}),
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Catalog item");
      const after = await tx.catalogItem.findFirstOrThrow({
        where: { id: catalogItemId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: after.ownerLegalEntityId,
        action: AUDIT_ACTIONS.CATALOG_ITEM_UPDATED,
        entityType: "catalog_item",
        entityId: after.id,
        beforeData: { version: before.version, code: before.code, name: before.name },
        afterData: { version: after.version, code: after.code, name: after.name },
      });
      return after;
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Catalog item");
  }
}

export async function transferCatalogItemOwnership(
  ctx: AccessContext,
  catalogItemId: string,
  raw: unknown,
) {
  const input = parseOrThrow(TransferCatalogItemOwnershipSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Catalog item");
  assertHasLegalEntityAccess(ctx, input.newOwnerLegalEntityId);
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const before = await tx.catalogItem.findFirst({
        where: { id: catalogItemId, tenantId: ctx.tenantId },
      });
      if (!before) throw new NotFoundError("Catalog item");
      if (!canMutateOwner(ctx, before.ownerLegalEntityId)) {
        throw new ForbiddenError("Not permitted");
      }
      await lockCatalogItemAssignments(tx, ctx.tenantId, catalogItemId);
      const locked = await lockCatalogItemRow(tx, ctx.tenantId, catalogItemId);
      if (!locked) throw new NotFoundError("Catalog item");
      if (!canMutateOwner(ctx, locked.ownerLegalEntityId)) {
        throw new ForbiddenError("Not permitted");
      }
      if (locked.version !== input.expectedVersion) {
        throw new StaleVersionError("Catalog item");
      }
      if (locked.status === "ARCHIVED") {
        throw new ValidationError("Archived catalog items cannot transfer ownership");
      }
      if (locked.ownerLegalEntityId === input.newOwnerLegalEntityId) {
        throw new ValidationError("New owner must differ from the current owner");
      }
      const updated = await tx.catalogItem.updateMany({
        where: {
          id: catalogItemId,
          tenantId: ctx.tenantId,
          version: input.expectedVersion,
        },
        data: {
          ownerLegalEntityId: input.newOwnerLegalEntityId,
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Catalog item");
      const after = await tx.catalogItem.findFirstOrThrow({
        where: { id: catalogItemId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: after.ownerLegalEntityId,
        action: AUDIT_ACTIONS.CATALOG_ITEM_OWNERSHIP_TRANSFERRED,
        entityType: "catalog_item",
        entityId: after.id,
        beforeData: {
          ownerLegalEntityId: before.ownerLegalEntityId,
          version: before.version,
        },
        afterData: {
          ownerLegalEntityId: after.ownerLegalEntityId,
          version: after.version,
        },
      });
      return after;
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Catalog item");
  }
}
