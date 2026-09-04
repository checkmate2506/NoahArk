import type { AssignmentStatus, PartyStatus, TransactionClient } from "@noahark/db";

export interface LockedPriceListRow {
  id: string;
  status: PartyStatus;
  ownerLegalEntityId: string;
  version: number;
  currency: "SGD" | "MYR" | "IDR";
}

export interface LockedPriceListAssignmentRow {
  id: string;
  priceListId: string;
  legalEntityId: string;
  status: AssignmentStatus;
  version: number;
  isDefault: boolean;
}

export interface SharedPriceListAssignmentRow {
  id: string;
  priceListId: string;
  legalEntityId: string;
  status: AssignmentStatus;
}

export interface SharedCatalogItemAssignmentRow {
  id: string;
  catalogItemId: string;
  legalEntityId: string;
  status: AssignmentStatus;
}

export interface LockedPriceListEntryRow {
  id: string;
  legalEntityId: string;
  version: number;
  unitPrice: unknown;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export async function lockPriceListDefault(
  tx: TransactionClient,
  tenantId: string,
  legalEntityId: string,
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${`${"price" + "-list-default"}:${tenantId}:${legalEntityId}`}))`;
}

export async function lockPriceListAssignments(
  tx: TransactionClient,
  tenantId: string,
  priceListId: string,
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${`${"price" + "-list-assignments"}:${tenantId}:${priceListId}`}))`;
}

export async function lockPriceListRow(
  tx: TransactionClient,
  tenantId: string,
  priceListId: string,
): Promise<LockedPriceListRow | null> {
  const rows = await tx.$queryRaw<LockedPriceListRow[]>`
    SELECT id,
           status,
           owner_legal_entity_id AS "ownerLegalEntityId",
           version,
           currency
    FROM price_list
    WHERE id = ${priceListId} AND tenant_id = ${tenantId}
    FOR UPDATE`;
  return rows[0] ?? null;
}

export async function lockPriceListAssignmentRow(
  tx: TransactionClient,
  tenantId: string,
  assignmentId: string,
): Promise<LockedPriceListAssignmentRow | null> {
  const rows = await tx.$queryRaw<LockedPriceListAssignmentRow[]>`
    SELECT id,
           price_list_id AS "priceListId",
           legal_entity_id AS "legalEntityId",
           status,
           version,
           is_default AS "isDefault"
    FROM price_list_legal_entity_assignment
    WHERE id = ${assignmentId} AND tenant_id = ${tenantId}
    FOR UPDATE`;
  return rows[0] ?? null;
}

export async function sharePriceListAssignmentRow(
  tx: TransactionClient,
  tenantId: string,
  assignmentId: string,
): Promise<SharedPriceListAssignmentRow | null> {
  const rows = await tx.$queryRaw<SharedPriceListAssignmentRow[]>`
    SELECT id,
           price_list_id AS "priceListId",
           legal_entity_id AS "legalEntityId",
           status
    FROM price_list_legal_entity_assignment
    WHERE id = ${assignmentId} AND tenant_id = ${tenantId}
    FOR SHARE`;
  return rows[0] ?? null;
}

export async function shareCatalogItemAssignmentRow(
  tx: TransactionClient,
  tenantId: string,
  assignmentId: string,
): Promise<SharedCatalogItemAssignmentRow | null> {
  const rows = await tx.$queryRaw<SharedCatalogItemAssignmentRow[]>`
    SELECT id,
           catalog_item_id AS "catalogItemId",
           legal_entity_id AS "legalEntityId",
           status
    FROM catalog_item_legal_entity_assignment
    WHERE id = ${assignmentId} AND tenant_id = ${tenantId}
    FOR SHARE`;
  return rows[0] ?? null;
}

export async function lockPriceListEntryRow(
  tx: TransactionClient,
  tenantId: string,
  entryId: string,
): Promise<LockedPriceListEntryRow | null> {
  const rows = await tx.$queryRaw<LockedPriceListEntryRow[]>`
    SELECT id,
           legal_entity_id AS "legalEntityId",
           version,
           unit_price AS "unitPrice",
           effective_from AS "effectiveFrom",
           effective_to AS "effectiveTo"
    FROM price_list_entry
    WHERE id = ${entryId} AND tenant_id = ${tenantId}
    FOR UPDATE`;
  return rows[0] ?? null;
}
