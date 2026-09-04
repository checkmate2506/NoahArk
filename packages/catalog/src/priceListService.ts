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
import { lockPriceListAssignments, lockPriceListRow } from "./pricingLocking";
import {
  CreatePriceListSchema,
  ListPriceListsSchema,
  TransferPriceListOwnershipSchema,
  UpdatePriceListSchema,
} from "./pricingSchemas";
import { normaliseSearchTerm } from "./search";

function canMutateOwner(ctx: AccessContext, ownerLegalEntityId: string): boolean {
  return ctx.legalEntityIds.has(ownerLegalEntityId);
}

function rejectImmutablePriceListFields(raw: unknown): void {
  if (raw !== null && typeof raw === "object") {
    if ("currency" in raw) {
      throw new ValidationError("Price list currency is immutable");
    }
    if ("ownerLegalEntityId" in raw) {
      throw new ValidationError("Owner cannot be changed through update");
    }
  }
}

export async function createPriceList(ctx: AccessContext, raw: unknown) {
  const input = parseOrThrow(CreatePriceListSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  assertHasLegalEntityAccess(ctx, input.ownerLegalEntityId);
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const priceList = await tx.priceList.create({
        data: {
          tenantId: ctx.tenantId,
          ownerLegalEntityId: input.ownerLegalEntityId,
          code: input.code,
          name: input.name,
          currency: input.currency,
        },
      });
      const assignment = await tx.priceListLegalEntityAssignment.create({
        data: {
          tenantId: ctx.tenantId,
          priceListId: priceList.id,
          legalEntityId: input.ownerLegalEntityId,
          isDefault: false,
        },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: priceList.ownerLegalEntityId,
        action: AUDIT_ACTIONS.PRICE_LIST_CREATED,
        entityType: "price_list",
        entityId: priceList.id,
        afterData: {
          id: priceList.id,
          code: priceList.code,
          currency: priceList.currency,
          ownerLegalEntityId: priceList.ownerLegalEntityId,
          status: priceList.status,
          version: priceList.version,
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
      return { priceList, assignment };
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Price list");
  }
}

export async function getPriceList(ctx: AccessContext, priceListId: string) {
  requireNonEmptyLegalEntityScope(ctx);
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const priceList = await tx.priceList.findFirst({
      where: { id: priceListId, tenantId: ctx.tenantId },
    });
    if (!priceList) throw new NotFoundError("Price list");
    return priceList;
  });
}

export async function listPriceLists(ctx: AccessContext, raw: unknown = {}) {
  const input = parseOrThrow(ListPriceListsSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  const limit = boundPageSize(input.limit);
  const cursor = input.cursor ? decodeCreatedAtIdCursor(input.cursor) : null;
  const status = input.status ?? (input.includeArchived ? undefined : "ACTIVE");
  const q = input.q ? normaliseSearchTerm(input.q) : "";
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const rows = await tx.priceList.findMany({
      where: {
        tenantId: ctx.tenantId,
        ...(status ? { status } : {}),
        ...(input.currency ? { currency: input.currency } : {}),
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

export async function updatePriceList(
  ctx: AccessContext,
  priceListId: string,
  raw: unknown,
) {
  rejectImmutablePriceListFields(raw);
  const input = parseOrThrow(UpdatePriceListSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Price list");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const before = await tx.priceList.findFirst({
        where: { id: priceListId, tenantId: ctx.tenantId },
      });
      if (!before) throw new NotFoundError("Price list");
      if (!canMutateOwner(ctx, before.ownerLegalEntityId)) {
        throw new ForbiddenError("Not permitted");
      }
      const locked = await lockPriceListRow(tx, ctx.tenantId, priceListId);
      if (!locked) throw new NotFoundError("Price list");
      if (locked.version !== input.expectedVersion) {
        throw new StaleVersionError("Price list");
      }
      if (locked.status === "ARCHIVED") {
        throw new ValidationError("Archived price lists cannot be updated");
      }
      const updated = await tx.priceList.updateMany({
        where: {
          id: priceListId,
          tenantId: ctx.tenantId,
          version: input.expectedVersion,
        },
        data: {
          ...omitUndefined({
            code: input.code,
            name: input.name,
          }),
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Price list");
      const after = await tx.priceList.findFirstOrThrow({
        where: { id: priceListId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: after.ownerLegalEntityId,
        action: AUDIT_ACTIONS.PRICE_LIST_UPDATED,
        entityType: "price_list",
        entityId: after.id,
        beforeData: { version: before.version, code: before.code, name: before.name },
        afterData: { version: after.version, code: after.code, name: after.name },
      });
      return after;
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Price list");
  }
}

export async function transferPriceListOwnership(
  ctx: AccessContext,
  priceListId: string,
  raw: unknown,
) {
  const input = parseOrThrow(TransferPriceListOwnershipSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Price list");
  assertHasLegalEntityAccess(ctx, input.newOwnerLegalEntityId);
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const before = await tx.priceList.findFirst({
        where: { id: priceListId, tenantId: ctx.tenantId },
      });
      if (!before) throw new NotFoundError("Price list");
      if (!canMutateOwner(ctx, before.ownerLegalEntityId)) {
        throw new ForbiddenError("Not permitted");
      }
      await lockPriceListAssignments(tx, ctx.tenantId, priceListId);
      const locked = await lockPriceListRow(tx, ctx.tenantId, priceListId);
      if (!locked) throw new NotFoundError("Price list");
      if (!canMutateOwner(ctx, locked.ownerLegalEntityId)) {
        throw new ForbiddenError("Not permitted");
      }
      if (locked.version !== input.expectedVersion) {
        throw new StaleVersionError("Price list");
      }
      if (locked.status === "ARCHIVED") {
        throw new ValidationError("Archived price lists cannot transfer ownership");
      }
      if (locked.ownerLegalEntityId === input.newOwnerLegalEntityId) {
        throw new ValidationError("New owner must differ from the current owner");
      }
      const updated = await tx.priceList.updateMany({
        where: {
          id: priceListId,
          tenantId: ctx.tenantId,
          version: input.expectedVersion,
        },
        data: {
          ownerLegalEntityId: input.newOwnerLegalEntityId,
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Price list");
      const after = await tx.priceList.findFirstOrThrow({
        where: { id: priceListId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: after.ownerLegalEntityId,
        action: AUDIT_ACTIONS.PRICE_LIST_OWNERSHIP_TRANSFERRED,
        entityType: "price_list",
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
    mapCatalogDbError(error, "Price list");
  }
}
