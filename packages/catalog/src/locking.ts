import { ValidationError } from "@noahark/core";
import type { AssignmentStatus, PartyStatus, TransactionClient } from "@noahark/db";

export interface LockedCatalogItemRow {
  id: string;
  status: PartyStatus;
  ownerLegalEntityId: string;
  version: number;
  categoryId: string | null;
  baseUomId: string;
}

export interface LockedAssignmentRow {
  id: string;
  catalogItemId: string;
  legalEntityId: string;
  status: AssignmentStatus;
  version: number;
  entityItemCode: string | null;
}

export async function lockCatalogItemRow(
  tx: TransactionClient,
  tenantId: string,
  catalogItemId: string,
): Promise<LockedCatalogItemRow | null> {
  const rows = await tx.$queryRaw<LockedCatalogItemRow[]>`
    SELECT id,
           status,
           owner_legal_entity_id AS "ownerLegalEntityId",
           version,
           category_id AS "categoryId",
           base_uom_id AS "baseUomId"
    FROM catalog_item
    WHERE id = ${catalogItemId} AND tenant_id = ${tenantId}
    FOR UPDATE`;
  return rows[0] ?? null;
}

export async function lockCatalogItemAssignmentRow(
  tx: TransactionClient,
  tenantId: string,
  assignmentId: string,
): Promise<LockedAssignmentRow | null> {
  const rows = await tx.$queryRaw<LockedAssignmentRow[]>`
    SELECT id,
           catalog_item_id AS "catalogItemId",
           legal_entity_id AS "legalEntityId",
           status,
           version,
           entity_item_code AS "entityItemCode"
    FROM catalog_item_legal_entity_assignment
    WHERE id = ${assignmentId} AND tenant_id = ${tenantId}
    FOR UPDATE`;
  return rows[0] ?? null;
}

/** Serializes assignment-set and ownership-visibility mutations.
 * Key: catalog-item-assignments:<tenantId>:<catalogItemId> */
export async function lockCatalogItemAssignments(
  tx: TransactionClient,
  tenantId: string,
  catalogItemId: string,
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${`catalog-item-assignments:${tenantId}:${catalogItemId}`}))`;
}

export async function lockCategoryRow(
  tx: TransactionClient,
  tenantId: string,
  categoryId: string,
): Promise<{ id: string; isActive: boolean; version: number } | null> {
  const rows = await tx.$queryRaw<{ id: string; isActive: boolean; version: number }[]>`
    SELECT id, is_active AS "isActive", version
    FROM catalog_category
    WHERE id = ${categoryId} AND tenant_id = ${tenantId}
    FOR UPDATE`;
  return rows[0] ?? null;
}

export async function lockUnitOfMeasureRow(
  tx: TransactionClient,
  tenantId: string,
  uomId: string,
): Promise<{ id: string; isActive: boolean; version: number } | null> {
  const rows = await tx.$queryRaw<{ id: string; isActive: boolean; version: number }[]>`
    SELECT id, is_active AS "isActive", version
    FROM unit_of_measure
    WHERE id = ${uomId} AND tenant_id = ${tenantId}
    FOR UPDATE`;
  return rows[0] ?? null;
}

export async function requireActiveCategoryForShare(
  tx: TransactionClient,
  tenantId: string,
  categoryId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string; isActive: boolean }[]>`
    SELECT id, is_active AS "isActive"
    FROM catalog_category
    WHERE id = ${categoryId} AND tenant_id = ${tenantId}
    FOR SHARE`;
  const row = rows[0];
  if (!row || !row.isActive) {
    throw new ValidationError("Category is not available");
  }
}

export async function requireActiveUomForShare(
  tx: TransactionClient,
  tenantId: string,
  uomId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string; isActive: boolean }[]>`
    SELECT id, is_active AS "isActive"
    FROM unit_of_measure
    WHERE id = ${uomId} AND tenant_id = ${tenantId}
    FOR SHARE`;
  const row = rows[0];
  if (!row || !row.isActive) {
    throw new ValidationError("Unit of measure is not available");
  }
}
