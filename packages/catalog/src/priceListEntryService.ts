import { AUDIT_ACTIONS } from "@noahark/audit";
import {
  AppError,
  ConflictError,
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
  requireExpectedVersion,
  requireNonEmptyLegalEntityScope,
  tenantContextInput,
} from "@noahark/core";
import { type Prisma, withTenantContext } from "@noahark/db";
import { auditActorFields, writeAuditEvent } from "./audit";
import { formatCivilDate, parseCivilDate } from "./civilDate";
import { mapCatalogDbError, parseOrThrow } from "./errors";
import { formatDecimal, parseDecimalString } from "./pricingDecimal";
import { lockPriceListEntryRow } from "./pricingLocking";
import {
  ClosePriceListEntrySchema,
  CreatePriceListEntrySchema,
  decodeEffectiveFromIdCursor,
  encodeEffectiveFromIdCursor,
  ListPriceListEntriesSchema,
  ResolveEffectivePriceSchema,
  UpdatePriceListEntrySchema,
} from "./pricingSchemas";

type PresentedEntry = {
  id: string;
  tenantId: string;
  legalEntityId: string;
  priceListAssignmentId: string;
  catalogItemAssignmentId: string;
  unitPrice: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

function presentEntry(row: {
  id: string;
  tenantId: string;
  legalEntityId: string;
  priceListAssignmentId: string;
  catalogItemAssignmentId: string;
  unitPrice: Prisma.Decimal;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}): PresentedEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    priceListAssignmentId: row.priceListAssignmentId,
    catalogItemAssignmentId: row.catalogItemAssignmentId,
    unitPrice: formatDecimal(row.unitPrice),
    effectiveFrom: formatCivilDate(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? formatCivilDate(row.effectiveTo) : null,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requireActiveMasters(
  priceList: { status: string } | null,
  catalogItem: { status: string } | null,
): void {
  if (!priceList || priceList.status !== "ACTIVE") {
    throw new ConflictError("Price list is not active");
  }
  if (!catalogItem || catalogItem.status !== "ACTIVE") {
    throw new ConflictError("Catalog item is not active");
  }
}

export async function createPriceListEntry(ctx: AccessContext, raw: unknown) {
  const input = parseOrThrow(CreatePriceListEntrySchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  const unitPrice = parseDecimalString(input.unitPrice);
  const effectiveFrom = parseCivilDate(input.effectiveFrom);
  const effectiveTo =
    input.effectiveTo === null ? null : parseCivilDate(input.effectiveTo);
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const priceListAssignmentRows = await tx.$queryRaw<
        { id: string; priceListId: string; legalEntityId: string; status: string }[]
      >`
        SELECT id,
               price_list_id AS "priceListId",
               legal_entity_id AS "legalEntityId",
               status
        FROM price_list_legal_entity_assignment
        WHERE id = ${input.priceListAssignmentId} AND tenant_id = ${ctx.tenantId}
        FOR SHARE`;
      const priceListAssignment = priceListAssignmentRows[0] ?? null;
      if (!priceListAssignment) throw new NotFoundError("Assignment");
      if (priceListAssignment.status !== "ACTIVE") {
        throw new ConflictError("Assignment is not active");
      }
      assertHasLegalEntityAccess(ctx, priceListAssignment.legalEntityId);

      const catalogItemAssignmentRows = await tx.$queryRaw<
        { id: string; catalogItemId: string; legalEntityId: string; status: string }[]
      >`
        SELECT id,
               catalog_item_id AS "catalogItemId",
               legal_entity_id AS "legalEntityId",
               status
        FROM catalog_item_legal_entity_assignment
        WHERE id = ${input.catalogItemAssignmentId} AND tenant_id = ${ctx.tenantId}
        FOR SHARE`;
      const catalogItemAssignment = catalogItemAssignmentRows[0] ?? null;
      if (!catalogItemAssignment) throw new NotFoundError("Assignment");
      if (catalogItemAssignment.status !== "ACTIVE") {
        throw new ConflictError("Assignment is not active");
      }
      if (catalogItemAssignment.legalEntityId !== priceListAssignment.legalEntityId) {
        throw new ValidationError(
          "Price list and catalog item assignments must belong to the same legal entity",
        );
      }

      const priceList = await tx.priceList.findFirst({
        where: { id: priceListAssignment.priceListId, tenantId: ctx.tenantId },
      });
      const catalogItem = await tx.catalogItem.findFirst({
        where: { id: catalogItemAssignment.catalogItemId, tenantId: ctx.tenantId },
      });
      requireActiveMasters(priceList, catalogItem);

      const entry = await tx.priceListEntry.create({
        data: {
          tenantId: ctx.tenantId,
          legalEntityId: priceListAssignment.legalEntityId,
          priceListAssignmentId: priceListAssignment.id,
          catalogItemAssignmentId: catalogItemAssignment.id,
          unitPrice,
          effectiveFrom,
          effectiveTo,
        },
      });
      const presented = presentEntry(entry);
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: presented.legalEntityId,
        action: AUDIT_ACTIONS.PRICE_LIST_ENTRY_CREATED,
        entityType: "price_list_entry",
        entityId: presented.id,
        afterData: {
          id: presented.id,
          unitPrice: presented.unitPrice,
          effectiveFrom: presented.effectiveFrom,
          effectiveTo: presented.effectiveTo,
          version: presented.version,
        },
      });
      return presented;
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Price list entry");
  }
}

export async function getPriceListEntry(ctx: AccessContext, entryId: string) {
  requireNonEmptyLegalEntityScope(ctx);
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const entry = await tx.priceListEntry.findFirst({
      where: { id: entryId, tenantId: ctx.tenantId },
    });
    if (!entry) throw new NotFoundError("Price list entry");
    return presentEntry(entry);
  });
}

export async function listPriceListEntries(ctx: AccessContext, raw: unknown = {}) {
  const input = parseOrThrow(ListPriceListEntriesSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  if (input.legalEntityId) {
    assertHasLegalEntityAccess(ctx, input.legalEntityId);
  }
  const entityFilter = input.legalEntityId
    ? [input.legalEntityId]
    : Array.from(ctx.legalEntityIds);
  const limit = boundPageSize(input.limit);
  const cursor = input.cursor ? decodeEffectiveFromIdCursor(input.cursor) : null;
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const rows = await tx.priceListEntry.findMany({
      where: {
        tenantId: ctx.tenantId,
        legalEntityId: { in: entityFilter },
        ...(input.priceListAssignmentId
          ? { priceListAssignmentId: input.priceListAssignmentId }
          : {}),
        ...(input.catalogItemAssignmentId
          ? { catalogItemAssignmentId: input.catalogItemAssignmentId }
          : {}),
        AND: [
          ...(cursor
            ? [
                {
                  OR: [
                    { effectiveFrom: { lt: cursor.effectiveFrom } },
                    {
                      effectiveFrom: cursor.effectiveFrom,
                      id: { lt: cursor.id },
                    },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ effectiveFrom: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map(presentEntry),
      nextCursor:
        hasMore && last ? encodeEffectiveFromIdCursor(last.effectiveFrom, last.id) : null,
    };
  });
}

export async function updatePriceListEntry(
  ctx: AccessContext,
  entryId: string,
  raw: unknown,
) {
  const input = parseOrThrow(UpdatePriceListEntrySchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Price list entry");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const before = await tx.priceListEntry.findFirst({
        where: { id: entryId, tenantId: ctx.tenantId },
      });
      if (!before) throw new NotFoundError("Price list entry");

      const priceListAssignmentRows = await tx.$queryRaw<
        { id: string; priceListId: string; legalEntityId: string; status: string }[]
      >`
        SELECT id,
               price_list_id AS "priceListId",
               legal_entity_id AS "legalEntityId",
               status
        FROM price_list_legal_entity_assignment
        WHERE id = ${before.priceListAssignmentId} AND tenant_id = ${ctx.tenantId}
        FOR SHARE`;
      const priceListAssignment = priceListAssignmentRows[0] ?? null;
      if (!priceListAssignment) throw new NotFoundError("Assignment");
      if (priceListAssignment.status !== "ACTIVE") {
        throw new ConflictError("Assignment is not active");
      }
      const catalogItemAssignmentRows = await tx.$queryRaw<
        { id: string; catalogItemId: string; legalEntityId: string; status: string }[]
      >`
        SELECT id,
               catalog_item_id AS "catalogItemId",
               legal_entity_id AS "legalEntityId",
               status
        FROM catalog_item_legal_entity_assignment
        WHERE id = ${before.catalogItemAssignmentId} AND tenant_id = ${ctx.tenantId}
        FOR SHARE`;
      const catalogItemAssignment = catalogItemAssignmentRows[0] ?? null;
      if (!catalogItemAssignment) throw new NotFoundError("Assignment");
      if (catalogItemAssignment.status !== "ACTIVE") {
        throw new ConflictError("Assignment is not active");
      }

      const priceList = await tx.priceList.findFirst({
        where: { id: priceListAssignment.priceListId, tenantId: ctx.tenantId },
      });
      const catalogItem = await tx.catalogItem.findFirst({
        where: { id: catalogItemAssignment.catalogItemId, tenantId: ctx.tenantId },
      });
      requireActiveMasters(priceList, catalogItem);

      const locked = await lockPriceListEntryRow(tx, ctx.tenantId, entryId);
      if (!locked) throw new NotFoundError("Price list entry");
      if (locked.version !== input.expectedVersion) {
        throw new StaleVersionError("Price list entry");
      }

      const nextFrom =
        input.effectiveFrom !== undefined
          ? parseCivilDate(input.effectiveFrom)
          : locked.effectiveFrom;
      const nextTo =
        input.effectiveTo === undefined
          ? locked.effectiveTo
          : input.effectiveTo === null
            ? null
            : parseCivilDate(input.effectiveTo);
      if (nextTo !== null && formatCivilDate(nextTo) < formatCivilDate(nextFrom)) {
        throw new ValidationError("effectiveTo must be on or after effectiveFrom");
      }

      const updated = await tx.priceListEntry.updateMany({
        where: {
          id: entryId,
          tenantId: ctx.tenantId,
          version: input.expectedVersion,
        },
        data: {
          ...omitUndefined({
            unitPrice:
              input.unitPrice !== undefined
                ? parseDecimalString(input.unitPrice)
                : undefined,
            effectiveFrom: input.effectiveFrom !== undefined ? nextFrom : undefined,
          }),
          ...(input.effectiveTo !== undefined ? { effectiveTo: nextTo } : {}),
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Price list entry");
      const after = await tx.priceListEntry.findFirstOrThrow({
        where: { id: entryId, tenantId: ctx.tenantId },
      });
      const presented = presentEntry(after);
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: presented.legalEntityId,
        action: AUDIT_ACTIONS.PRICE_LIST_ENTRY_UPDATED,
        entityType: "price_list_entry",
        entityId: presented.id,
        beforeData: {
          version: before.version,
          unitPrice: formatDecimal(before.unitPrice),
          effectiveFrom: formatCivilDate(before.effectiveFrom),
          effectiveTo: before.effectiveTo ? formatCivilDate(before.effectiveTo) : null,
        },
        afterData: {
          version: presented.version,
          unitPrice: presented.unitPrice,
          effectiveFrom: presented.effectiveFrom,
          effectiveTo: presented.effectiveTo,
        },
      });
      return presented;
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Price list entry");
  }
}

export async function closePriceListEntry(
  ctx: AccessContext,
  entryId: string,
  raw: unknown,
) {
  // Closing only shrinks the effective interval, cannot introduce new coverage,
  // and cannot raise an exclusion conflict. This path must not consult a master
  // or an assignment row; audit metadata uses the locked row's own legalEntityId.
  const input = parseOrThrow(ClosePriceListEntrySchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Price list entry");
  const nextTo = parseCivilDate(input.effectiveTo);
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const visible = await tx.priceListEntry.findFirst({
        where: { id: entryId, tenantId: ctx.tenantId },
      });
      if (!visible) throw new NotFoundError("Price list entry");
      const locked = await lockPriceListEntryRow(tx, ctx.tenantId, entryId);
      if (!locked) throw new NotFoundError("Price list entry");
      if (locked.version !== input.expectedVersion) {
        throw new StaleVersionError("Price list entry");
      }
      const fromText = formatCivilDate(locked.effectiveFrom);
      const nextText = formatCivilDate(nextTo);
      if (nextText < fromText) {
        throw new ValidationError("effectiveTo must be on or after effectiveFrom");
      }
      if (locked.effectiveTo !== null) {
        const currentTo = formatCivilDate(locked.effectiveTo);
        if (nextText >= currentTo) {
          throw new ValidationError("A closed price period cannot be extended");
        }
      }
      const updated = await tx.priceListEntry.updateMany({
        where: {
          id: entryId,
          tenantId: ctx.tenantId,
          version: input.expectedVersion,
        },
        data: {
          effectiveTo: nextTo,
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Price list entry");
      const after = await tx.priceListEntry.findFirstOrThrow({
        where: { id: entryId, tenantId: ctx.tenantId },
      });
      const presented = presentEntry(after);
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: presented.legalEntityId,
        action: AUDIT_ACTIONS.PRICE_LIST_ENTRY_CLOSED,
        entityType: "price_list_entry",
        entityId: presented.id,
        beforeData: {
          version: visible.version,
          effectiveTo: visible.effectiveTo ? formatCivilDate(visible.effectiveTo) : null,
        },
        afterData: {
          version: presented.version,
          effectiveTo: presented.effectiveTo,
        },
      });
      return presented;
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCatalogDbError(error, "Price list entry");
  }
}

export async function resolveEffectivePrice(ctx: AccessContext, raw: unknown) {
  const input = parseOrThrow(ResolveEffectivePriceSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  assertHasLegalEntityAccess(ctx, input.legalEntityId);
  const onDate = parseCivilDate(input.onDate);
  const onDateText = formatCivilDate(onDate);

  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    let priceListAssignment: {
      id: string;
      priceListId: string;
      legalEntityId: string;
      status: string;
    };
    let priceList: { id: string; status: string; currency: string };

    if (input.priceListId) {
      const foundList = await tx.priceList.findFirst({
        where: { id: input.priceListId, tenantId: ctx.tenantId },
      });
      if (!foundList || foundList.status !== "ACTIVE") {
        throw new NotFoundError("Price list");
      }
      priceList = foundList;
      const foundAssignment = await tx.priceListLegalEntityAssignment.findFirst({
        where: {
          tenantId: ctx.tenantId,
          priceListId: input.priceListId,
          legalEntityId: input.legalEntityId,
          status: "ACTIVE",
        },
      });
      if (!foundAssignment) throw new NotFoundError("Price list");
      priceListAssignment = foundAssignment;
    } else {
      const foundAssignment = await tx.priceListLegalEntityAssignment.findFirst({
        where: {
          tenantId: ctx.tenantId,
          legalEntityId: input.legalEntityId,
          isDefault: true,
          status: "ACTIVE",
        },
      });
      if (!foundAssignment) throw new NotFoundError("Price list");
      priceListAssignment = foundAssignment;
      const foundList = await tx.priceList.findFirst({
        where: { id: foundAssignment.priceListId, tenantId: ctx.tenantId },
      });
      if (!foundList || foundList.status !== "ACTIVE") {
        throw new NotFoundError("Price list");
      }
      priceList = foundList;
    }

    const catalogItem = await tx.catalogItem.findFirst({
      where: { id: input.catalogItemId, tenantId: ctx.tenantId },
    });
    if (!catalogItem || catalogItem.status !== "ACTIVE") {
      throw new NotFoundError("Price list");
    }
    const catalogItemAssignment = await tx.catalogItemLegalEntityAssignment.findFirst({
      where: {
        tenantId: ctx.tenantId,
        catalogItemId: input.catalogItemId,
        legalEntityId: input.legalEntityId,
        status: "ACTIVE",
      },
    });
    if (!catalogItemAssignment) throw new NotFoundError("Price list");

    const covering = await tx.priceListEntry.findMany({
      where: {
        tenantId: ctx.tenantId,
        legalEntityId: input.legalEntityId,
        priceListAssignmentId: priceListAssignment.id,
        catalogItemAssignmentId: catalogItemAssignment.id,
        AND: [
          { effectiveFrom: { lte: onDate } },
          { OR: [{ effectiveTo: null }, { effectiveTo: { gte: onDate } }] },
        ],
      },
    });
    if (covering.length > 1) {
      throw new AppError("INTERNAL_ERROR", "An unexpected error occurred", 500);
    }

    const base = {
      currency: priceList.currency,
      priceListId: priceList.id,
      priceListAssignmentId: priceListAssignment.id,
      catalogItemAssignmentId: catalogItemAssignment.id,
      legalEntityId: input.legalEntityId,
      onDate: onDateText,
    };
    const hit = covering[0];
    if (!hit) {
      return { resolved: false as const, unitPrice: null, ...base };
    }
    return {
      resolved: true as const,
      unitPrice: formatDecimal(hit.unitPrice),
      ...base,
      entryId: hit.id,
      effectiveFrom: formatCivilDate(hit.effectiveFrom),
      effectiveTo: hit.effectiveTo ? formatCivilDate(hit.effectiveTo) : null,
    };
  });
}
