import type { CustomFieldDataType, TransactionClient } from "@noahark/db";

export interface LockedDefinitionRow {
  id: string;
  entityType: string;
  dataType: CustomFieldDataType;
  isActive: boolean;
  options: unknown;
  version: number;
}

export interface LockedValueRow {
  id: string;
  version: number;
}

export function customFieldValueLockKey(
  tenantId: string,
  definitionId: string,
  entityId: string,
): string {
  return `custom-field-value:${tenantId}:${definitionId}:${entityId}`;
}

export async function acquireCustomFieldValueLock(
  tx: TransactionClient,
  tenantId: string,
  definitionId: string,
  entityId: string,
): Promise<void> {
  const key = customFieldValueLockKey(tenantId, definitionId, entityId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

export async function lockDefinitionForUpdate(
  tx: TransactionClient,
  tenantId: string,
  definitionId: string,
): Promise<LockedDefinitionRow | null> {
  const rows = await tx.$queryRaw<LockedDefinitionRow[]>`
    SELECT id,
           entity_type AS "entityType",
           data_type AS "dataType",
           is_active AS "isActive",
           options,
           version
    FROM custom_field_definition
    WHERE id = ${definitionId} AND tenant_id = ${tenantId}
    FOR UPDATE`;
  return rows[0] ?? null;
}

export async function lockDefinitionForShare(
  tx: TransactionClient,
  tenantId: string,
  definitionId: string,
): Promise<LockedDefinitionRow | null> {
  const rows = await tx.$queryRaw<LockedDefinitionRow[]>`
    SELECT id,
           entity_type AS "entityType",
           data_type AS "dataType",
           is_active AS "isActive",
           options,
           version
    FROM custom_field_definition
    WHERE id = ${definitionId} AND tenant_id = ${tenantId}
    FOR SHARE`;
  return rows[0] ?? null;
}

export async function lockCustomFieldValueForUpdate(
  tx: TransactionClient,
  tenantId: string,
  valueId: string,
): Promise<LockedValueRow | null> {
  const rows = await tx.$queryRaw<LockedValueRow[]>`
    SELECT id, version
    FROM custom_field_value
    WHERE id = ${valueId} AND tenant_id = ${tenantId}
    FOR UPDATE`;
  return rows[0] ?? null;
}
