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
import { withTenantContext, Prisma, type CustomFieldDefinition } from "@noahark/db";
import { auditActorFields, writeAuditEvent } from "./audit";
import { mapCustomFieldDbError, parseOrThrow } from "./errors";
import { lockDefinitionForUpdate } from "./locking";
import {
  CreateCustomFieldDefinitionSchema,
  CustomFieldDefinitionIdVersionSchema,
  ListCustomFieldDefinitionsSchema,
  UpdateCustomFieldDefinitionSchema,
} from "./schemas";
import { assertOptionsAddOnly, canonicalizeOptions, readOptions } from "./typedValue";

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

function definitionDto(row: CustomFieldDefinition) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    entityType: row.entityType,
    key: row.key,
    label: row.label,
    dataType: row.dataType,
    isRequired: row.isRequired,
    options: row.dataType === "SINGLE_SELECT" ? readOptions(row.options) : null,
    isActive: row.isActive,
    displayOrder: row.displayOrder,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createCustomFieldDefinition(ctx: AccessContext, raw: unknown) {
  rejectUnexpectedKeys(raw, ["legalEntityId", "tenantId"], "Invalid input");
  const input = parseOrThrow(CreateCustomFieldDefinitionSchema, raw);
  if (input.dataType === "SINGLE_SELECT") {
    if (input.options === undefined) {
      throw new ValidationError("Custom field options are required");
    }
  } else if (input.options !== undefined) {
    throw new ValidationError("Custom field options are only valid for SINGLE_SELECT");
  }
  const options =
    input.dataType === "SINGLE_SELECT" ? canonicalizeOptions(input.options) : null;
  requireNonEmptyLegalEntityScope(ctx);
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const row = await tx.customFieldDefinition.create({
        data: {
          tenantId: ctx.tenantId,
          legalEntityId: null,
          entityType: input.entityType,
          key: input.key,
          label: input.label,
          dataType: input.dataType,
          isRequired: input.isRequired ?? false,
          options: options === null ? Prisma.DbNull : options,
          displayOrder: input.displayOrder ?? 0,
        },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: null,
        action: AUDIT_ACTIONS.CUSTOM_FIELD_DEFINITION_CREATED,
        entityType: "custom_field_definition",
        entityId: row.id,
        afterData: {
          id: row.id,
          entityType: row.entityType,
          key: row.key,
          dataType: row.dataType,
          isActive: row.isActive,
          version: row.version,
        },
      });
      return definitionDto(row);
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCustomFieldDbError(error, "Custom field definition");
  }
}

export async function getCustomFieldDefinition(ctx: AccessContext, definitionId: string) {
  requireNonEmptyLegalEntityScope(ctx);
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const row = await tx.customFieldDefinition.findFirst({
      where: { id: definitionId, tenantId: ctx.tenantId },
    });
    if (!row) throw new NotFoundError("Custom field definition");
    return definitionDto(row);
  });
}

export async function listCustomFieldDefinitions(ctx: AccessContext, raw: unknown = {}) {
  const input = parseOrThrow(ListCustomFieldDefinitionsSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  const limit = boundPageSize(input.limit);
  const cursor = input.cursor ? decodeCreatedAtIdCursor(input.cursor) : null;
  const isActive = input.isActive ?? true;
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const rows = await tx.customFieldDefinition.findMany({
      where: {
        tenantId: ctx.tenantId,
        isActive,
        ...(input.entityType ? { entityType: input.entityType } : {}),
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
      definitions: page.map(definitionDto),
      nextCursor:
        hasMore && last ? encodeCreatedAtIdCursor(last.createdAt, last.id) : null,
    };
  });
}

export async function updateCustomFieldDefinition(
  ctx: AccessContext,
  definitionId: string,
  raw: unknown,
) {
  rejectUnexpectedKeys(
    raw,
    ["entityType", "key", "dataType", "legalEntityId", "tenantId"],
    "Custom field identity is immutable",
  );
  const input = parseOrThrow(UpdateCustomFieldDefinitionSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Custom field definition");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const before = await tx.customFieldDefinition.findFirst({
        where: { id: definitionId, tenantId: ctx.tenantId },
      });
      if (!before) throw new NotFoundError("Custom field definition");
      const locked = await lockDefinitionForUpdate(tx, ctx.tenantId, definitionId);
      if (!locked) throw new NotFoundError("Custom field definition");
      if (locked.version !== input.expectedVersion) {
        throw new StaleVersionError("Custom field definition");
      }
      let nextOptions: string[] | undefined;
      if (input.options !== undefined) {
        if (before.dataType !== "SINGLE_SELECT") {
          throw new ValidationError(
            "Custom field options are only valid for SINGLE_SELECT",
          );
        }
        const previous = readOptions(before.options) ?? [];
        const canonical = canonicalizeOptions(input.options);
        assertOptionsAddOnly(previous, canonical);
        nextOptions = canonical;
      }
      const updated = await tx.customFieldDefinition.updateMany({
        where: {
          id: definitionId,
          tenantId: ctx.tenantId,
          version: input.expectedVersion,
        },
        data: {
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
          ...(input.displayOrder !== undefined
            ? { displayOrder: input.displayOrder }
            : {}),
          ...(nextOptions !== undefined ? { options: nextOptions } : {}),
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Custom field definition");
      const after = await tx.customFieldDefinition.findFirstOrThrow({
        where: { id: definitionId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: null,
        action: AUDIT_ACTIONS.CUSTOM_FIELD_DEFINITION_UPDATED,
        entityType: "custom_field_definition",
        entityId: after.id,
        beforeData: { version: before.version },
        afterData: {
          id: after.id,
          entityType: after.entityType,
          key: after.key,
          version: after.version,
        },
      });
      return definitionDto(after);
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCustomFieldDbError(error, "Custom field definition");
  }
}

export async function deactivateCustomFieldDefinition(
  ctx: AccessContext,
  definitionId: string,
  raw: unknown,
) {
  const input = parseOrThrow(CustomFieldDefinitionIdVersionSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Custom field definition");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const before = await tx.customFieldDefinition.findFirst({
        where: { id: definitionId, tenantId: ctx.tenantId },
      });
      if (!before) throw new NotFoundError("Custom field definition");
      const locked = await lockDefinitionForUpdate(tx, ctx.tenantId, definitionId);
      if (!locked) throw new NotFoundError("Custom field definition");
      if (locked.version !== input.expectedVersion) {
        throw new StaleVersionError("Custom field definition");
      }
      if (!locked.isActive) {
        throw new ValidationError("Custom field definition is already inactive");
      }
      const updated = await tx.customFieldDefinition.updateMany({
        where: {
          id: definitionId,
          tenantId: ctx.tenantId,
          version: input.expectedVersion,
        },
        data: {
          isActive: false,
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Custom field definition");
      const after = await tx.customFieldDefinition.findFirstOrThrow({
        where: { id: definitionId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: null,
        action: AUDIT_ACTIONS.CUSTOM_FIELD_DEFINITION_DEACTIVATED,
        entityType: "custom_field_definition",
        entityId: after.id,
        beforeData: { version: before.version, isActive: before.isActive },
        afterData: { version: after.version, isActive: after.isActive },
      });
      return definitionDto(after);
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCustomFieldDbError(error, "Custom field definition");
  }
}

export async function activateCustomFieldDefinition(
  ctx: AccessContext,
  definitionId: string,
  raw: unknown,
) {
  const input = parseOrThrow(CustomFieldDefinitionIdVersionSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Custom field definition");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const before = await tx.customFieldDefinition.findFirst({
        where: { id: definitionId, tenantId: ctx.tenantId },
      });
      if (!before) throw new NotFoundError("Custom field definition");
      const locked = await lockDefinitionForUpdate(tx, ctx.tenantId, definitionId);
      if (!locked) throw new NotFoundError("Custom field definition");
      if (locked.version !== input.expectedVersion) {
        throw new StaleVersionError("Custom field definition");
      }
      if (locked.isActive) {
        throw new ValidationError("Custom field definition is already active");
      }
      const updated = await tx.customFieldDefinition.updateMany({
        where: {
          id: definitionId,
          tenantId: ctx.tenantId,
          version: input.expectedVersion,
        },
        data: {
          isActive: true,
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Custom field definition");
      const after = await tx.customFieldDefinition.findFirstOrThrow({
        where: { id: definitionId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: null,
        action: AUDIT_ACTIONS.CUSTOM_FIELD_DEFINITION_ACTIVATED,
        entityType: "custom_field_definition",
        entityId: after.id,
        beforeData: { version: before.version, isActive: before.isActive },
        afterData: { version: after.version, isActive: after.isActive },
      });
      return definitionDto(after);
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapCustomFieldDbError(error, "Custom field definition");
  }
}
