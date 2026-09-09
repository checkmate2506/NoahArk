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
  boundPageSize,
  decodeCreatedAtIdCursor,
  encodeCreatedAtIdCursor,
  requireNonEmptyLegalEntityScope,
  tenantContextInput,
} from "@noahark/core";
import { withTenantContext, type CustomFieldValue } from "@noahark/db";
import { auditActorFields, writeAuditEvent } from "./audit";
import { mapCustomFieldDbError, parseOrThrow } from "./errors";
import {
  acquireCustomFieldValueLock,
  lockCustomFieldValueForUpdate,
  lockDefinitionForShare,
} from "./locking";
import {
  ListCustomFieldValuesSchema,
  PHASE2_ENTITY_TYPES,
  SetCustomFieldValueSchema,
  type Phase2EntityType,
  type SupportedDataType,
} from "./schemas";
import { shareAndResolveTarget } from "./targets";
import {
  canonicalizeEnvelope,
  envelopeToStorage,
  readOptions,
  rowToEnvelope,
  type TypedValueEnvelope,
} from "./typedValue";

function rejectUnexpectedKeys(
  raw: unknown,
  banned: readonly string[],
  message: string,
): void {
  if (raw !== null && typeof raw === "object") {
    for (const key of banned) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) {
        throw new ValidationError(message);
      }
    }
  }
}

function valueDto(row: CustomFieldValue) {
  const typedValue: TypedValueEnvelope = rowToEnvelope(row);
  return {
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    definitionId: row.definitionId,
    entityType: row.entityType,
    entityId: row.entityId,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    typedValue,
  };
}

function asPhase2EntityType(raw: string): Phase2EntityType {
  if ((PHASE2_ENTITY_TYPES as readonly string[]).includes(raw)) {
    return raw as Phase2EntityType;
  }
  throw new ValidationError("Custom field target type is not supported");
}

function asSupportedDataType(raw: string): SupportedDataType {
  switch (raw) {
    case "STRING":
    case "INTEGER":
    case "DECIMAL":
    case "BOOLEAN":
    case "DATE":
    case "SINGLE_SELECT":
      return raw;
    default:
      throw new ValidationError("Custom field data type is not supported");
  }
}

export async function setCustomFieldValue(ctx: AccessContext, raw: unknown) {
  rejectUnexpectedKeys(raw, ["legalEntityId", "tenantId", "entityType"], "Invalid input");
  const input = parseOrThrow(SetCustomFieldValueSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      await acquireCustomFieldValueLock(
        tx,
        ctx.tenantId,
        input.definitionId,
        input.entityId,
      );
      const definition = await lockDefinitionForShare(
        tx,
        ctx.tenantId,
        input.definitionId,
      );
      if (!definition) throw new NotFoundError("Custom field definition");
      if (!definition.isActive) {
        throw new ConflictError("Custom field definition is not active");
      }
      const lockedType = asSupportedDataType(definition.dataType);
      const options =
        lockedType === "SINGLE_SELECT" ? readOptions(definition.options) : null;
      const envelope = canonicalizeEnvelope(input.value, lockedType, options);
      const target = await shareAndResolveTarget(
        tx,
        ctx,
        asPhase2EntityType(definition.entityType),
        input.entityId,
      );
      if (target.entityType !== definition.entityType) {
        throw new ValidationError("Custom field target does not match the definition");
      }
      const storage = envelopeToStorage(envelope);
      const existing = await tx.customFieldValue.findFirst({
        where: {
          tenantId: ctx.tenantId,
          definitionId: input.definitionId,
          entityId: input.entityId,
        },
      });
      if (existing) {
        const lockedValue = await lockCustomFieldValueForUpdate(
          tx,
          ctx.tenantId,
          existing.id,
        );
        if (!lockedValue) throw new NotFoundError("Custom field value");
        const updated = await tx.customFieldValue.updateMany({
          where: {
            id: existing.id,
            tenantId: ctx.tenantId,
            version: lockedValue.version,
          },
          data: {
            legalEntityId: target.legalEntityId,
            entityType: target.entityType,
            ...storage,
            version: { increment: 1 },
          },
        });
        if (updated.count === 0) throw new StaleVersionError("Custom field value");
        const after = await tx.customFieldValue.findFirstOrThrow({
          where: { id: existing.id, tenantId: ctx.tenantId },
        });
        await writeAuditEvent(tx, {
          ...auditActorFields(ctx),
          legalEntityId: target.legalEntityId,
          action: AUDIT_ACTIONS.CUSTOM_FIELD_VALUE_UPDATED,
          entityType: "custom_field_value",
          entityId: after.id,
          beforeData: {
            definitionId: after.definitionId,
            entityType: after.entityType,
            entityId: after.entityId,
            version: existing.version,
          },
          afterData: {
            id: after.id,
            definitionId: after.definitionId,
            entityType: after.entityType,
            entityId: after.entityId,
            version: after.version,
          },
        });
        return valueDto(after);
      }
      const created = await tx.customFieldValue.create({
        data: {
          tenantId: ctx.tenantId,
          legalEntityId: target.legalEntityId,
          definitionId: input.definitionId,
          entityType: target.entityType,
          entityId: target.entityId,
          ...storage,
        },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: target.legalEntityId,
        action: AUDIT_ACTIONS.CUSTOM_FIELD_VALUE_CREATED,
        entityType: "custom_field_value",
        entityId: created.id,
        afterData: {
          id: created.id,
          definitionId: created.definitionId,
          entityType: created.entityType,
          entityId: created.entityId,
          version: created.version,
        },
      });
      return valueDto(created);
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCustomFieldDbError(error, "Custom field value");
  }
}

export async function getCustomFieldValue(ctx: AccessContext, valueId: string) {
  requireNonEmptyLegalEntityScope(ctx);
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const row = await tx.customFieldValue.findFirst({
      where: { id: valueId, tenantId: ctx.tenantId },
    });
    if (!row) throw new NotFoundError("Custom field value");
    return valueDto(row);
  });
}

export async function listCustomFieldValues(ctx: AccessContext, raw: unknown = {}) {
  const input = parseOrThrow(ListCustomFieldValuesSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  const limit = boundPageSize(input.limit);
  const cursor = input.cursor ? decodeCreatedAtIdCursor(input.cursor) : null;
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const rows = await tx.customFieldValue.findMany({
      where: {
        tenantId: ctx.tenantId,
        ...(input.definitionId ? { definitionId: input.definitionId } : {}),
        ...(input.entityType ? { entityType: input.entityType } : {}),
        ...(input.entityId ? { entityId: input.entityId } : {}),
        AND: [
          ...(cursor
            ? [
                {
                  OR: [
                    { createdAt: { gt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      values: page.map(valueDto),
      nextCursor:
        hasMore && last ? encodeCreatedAtIdCursor(last.createdAt, last.id) : null,
    };
  });
}
