import {
  ConflictError,
  NotFoundError,
  assertHasLegalEntityAccess,
  type AccessContext,
} from "@noahark/core";
import type { AssignmentStatus, PartyStatus, TransactionClient } from "@noahark/db";
import type { Phase2EntityType } from "./schemas";

export interface ResolvedTarget {
  entityType: Phase2EntityType;
  entityId: string;
  legalEntityId: string;
}

type MasterRow = {
  id: string;
  tenantId: string;
  ownerLegalEntityId: string;
  status: PartyStatus;
};

type ScopedRow = {
  id: string;
  tenantId: string;
  legalEntityId: string;
  status: AssignmentStatus;
};

type ContactRow = {
  id: string;
  tenantId: string;
  partyId: string;
  status: PartyStatus;
};

function rejectArchived(status: string): void {
  if (status === "ARCHIVED") {
    throw new ConflictError("Target is archived");
  }
}

async function shareMaster(
  tx: TransactionClient,
  table: "party" | "catalog_item" | "price_list",
  tenantId: string,
  entityId: string,
): Promise<MasterRow | null> {
  if (table === "party") {
    const rows = await tx.$queryRaw<MasterRow[]>`
      SELECT id,
             tenant_id AS "tenantId",
             owner_legal_entity_id AS "ownerLegalEntityId",
             status
      FROM party
      WHERE id = ${entityId} AND tenant_id = ${tenantId}
      FOR SHARE`;
    return rows[0] ?? null;
  }
  if (table === "catalog_item") {
    const rows = await tx.$queryRaw<MasterRow[]>`
      SELECT id,
             tenant_id AS "tenantId",
             owner_legal_entity_id AS "ownerLegalEntityId",
             status
      FROM catalog_item
      WHERE id = ${entityId} AND tenant_id = ${tenantId}
      FOR SHARE`;
    return rows[0] ?? null;
  }
  const rows = await tx.$queryRaw<MasterRow[]>`
    SELECT id,
           tenant_id AS "tenantId",
           owner_legal_entity_id AS "ownerLegalEntityId",
           status
    FROM price_list
    WHERE id = ${entityId} AND tenant_id = ${tenantId}
    FOR SHARE`;
  return rows[0] ?? null;
}

async function shareScoped(
  tx: TransactionClient,
  table:
    | "party_legal_entity_assignment"
    | "customer_role"
    | "vendor_role"
    | "catalog_item_legal_entity_assignment"
    | "price_list_legal_entity_assignment",
  tenantId: string,
  entityId: string,
): Promise<ScopedRow | null> {
  if (table === "party_legal_entity_assignment") {
    const rows = await tx.$queryRaw<ScopedRow[]>`
      SELECT id, tenant_id AS "tenantId", legal_entity_id AS "legalEntityId", status
      FROM party_legal_entity_assignment
      WHERE id = ${entityId} AND tenant_id = ${tenantId}
      FOR SHARE`;
    return rows[0] ?? null;
  }
  if (table === "customer_role") {
    const rows = await tx.$queryRaw<ScopedRow[]>`
      SELECT id, tenant_id AS "tenantId", legal_entity_id AS "legalEntityId", status
      FROM customer_role
      WHERE id = ${entityId} AND tenant_id = ${tenantId}
      FOR SHARE`;
    return rows[0] ?? null;
  }
  if (table === "vendor_role") {
    const rows = await tx.$queryRaw<ScopedRow[]>`
      SELECT id, tenant_id AS "tenantId", legal_entity_id AS "legalEntityId", status
      FROM vendor_role
      WHERE id = ${entityId} AND tenant_id = ${tenantId}
      FOR SHARE`;
    return rows[0] ?? null;
  }
  if (table === "catalog_item_legal_entity_assignment") {
    const rows = await tx.$queryRaw<ScopedRow[]>`
      SELECT id, tenant_id AS "tenantId", legal_entity_id AS "legalEntityId", status
      FROM catalog_item_legal_entity_assignment
      WHERE id = ${entityId} AND tenant_id = ${tenantId}
      FOR SHARE`;
    return rows[0] ?? null;
  }
  const rows = await tx.$queryRaw<ScopedRow[]>`
    SELECT id, tenant_id AS "tenantId", legal_entity_id AS "legalEntityId", status
    FROM price_list_legal_entity_assignment
    WHERE id = ${entityId} AND tenant_id = ${tenantId}
    FOR SHARE`;
  return rows[0] ?? null;
}

async function resolveMaster(
  ctx: AccessContext,
  tx: TransactionClient,
  entityType: "party" | "catalog_item" | "price_list",
  entityId: string,
  visible: { id: string; ownerLegalEntityId: string } | null,
): Promise<ResolvedTarget> {
  if (!visible) throw new NotFoundError("Target");
  if (visible.id !== entityId) throw new NotFoundError("Target");
  assertHasLegalEntityAccess(ctx, visible.ownerLegalEntityId);
  const locked = await shareMaster(tx, entityType, ctx.tenantId, entityId);
  if (!locked) throw new NotFoundError("Target");
  if (locked.tenantId !== ctx.tenantId) throw new NotFoundError("Target");
  rejectArchived(locked.status);
  assertHasLegalEntityAccess(ctx, locked.ownerLegalEntityId);
  return {
    entityType,
    entityId: locked.id,
    legalEntityId: locked.ownerLegalEntityId,
  };
}

async function resolveScoped(
  ctx: AccessContext,
  tx: TransactionClient,
  entityType:
    | "party_legal_entity_assignment"
    | "customer_role"
    | "vendor_role"
    | "catalog_item_legal_entity_assignment"
    | "price_list_legal_entity_assignment",
  entityId: string,
  visible: { id: string; legalEntityId: string } | null,
): Promise<ResolvedTarget> {
  if (!visible) throw new NotFoundError("Target");
  assertHasLegalEntityAccess(ctx, visible.legalEntityId);
  const locked = await shareScoped(tx, entityType, ctx.tenantId, entityId);
  if (!locked) throw new NotFoundError("Target");
  if (locked.tenantId !== ctx.tenantId) throw new NotFoundError("Target");
  rejectArchived(locked.status);
  assertHasLegalEntityAccess(ctx, locked.legalEntityId);
  return {
    entityType,
    entityId: locked.id,
    legalEntityId: locked.legalEntityId,
  };
}

/**
 * Ordinary RLS SELECT, then target FOR SHARE. Derives write authority from
 * the target owner (shared masters) or the row's own legal entity
 * (assignments and roles). Assigned visibility is not write authority.
 */
export async function shareAndResolveTarget(
  tx: TransactionClient,
  ctx: AccessContext,
  entityType: Phase2EntityType,
  entityId: string,
): Promise<ResolvedTarget> {
  switch (entityType) {
    case "party": {
      const visible = await tx.party.findFirst({
        where: { id: entityId, tenantId: ctx.tenantId },
        select: { id: true, ownerLegalEntityId: true },
      });
      return resolveMaster(ctx, tx, "party", entityId, visible);
    }
    case "catalog_item": {
      const visible = await tx.catalogItem.findFirst({
        where: { id: entityId, tenantId: ctx.tenantId },
        select: { id: true, ownerLegalEntityId: true },
      });
      return resolveMaster(ctx, tx, "catalog_item", entityId, visible);
    }
    case "price_list": {
      const visible = await tx.priceList.findFirst({
        where: { id: entityId, tenantId: ctx.tenantId },
        select: { id: true, ownerLegalEntityId: true },
      });
      return resolveMaster(ctx, tx, "price_list", entityId, visible);
    }
    case "party_contact": {
      const visible = await tx.partyContact.findFirst({
        where: { id: entityId, tenantId: ctx.tenantId },
        select: { id: true, partyId: true, status: true },
      });
      if (!visible) throw new NotFoundError("Target");
      const party = await tx.party.findFirst({
        where: { id: visible.partyId, tenantId: ctx.tenantId },
        select: { id: true, ownerLegalEntityId: true },
      });
      if (!party) throw new NotFoundError("Target");
      assertHasLegalEntityAccess(ctx, party.ownerLegalEntityId);
      const contactRows = await tx.$queryRaw<ContactRow[]>`
        SELECT id, tenant_id AS "tenantId", party_id AS "partyId", status
        FROM party_contact
        WHERE id = ${entityId} AND tenant_id = ${ctx.tenantId}
        FOR SHARE`;
      const contact = contactRows[0];
      if (!contact) throw new NotFoundError("Target");
      if (contact.tenantId !== ctx.tenantId) throw new NotFoundError("Target");
      rejectArchived(contact.status);
      const lockedParty = await shareMaster(tx, "party", ctx.tenantId, contact.partyId);
      if (!lockedParty) throw new NotFoundError("Target");
      rejectArchived(lockedParty.status);
      assertHasLegalEntityAccess(ctx, lockedParty.ownerLegalEntityId);
      return {
        entityType: "party_contact",
        entityId: contact.id,
        legalEntityId: lockedParty.ownerLegalEntityId,
      };
    }
    case "party_legal_entity_assignment": {
      const visible = await tx.partyLegalEntityAssignment.findFirst({
        where: { id: entityId, tenantId: ctx.tenantId },
        select: { id: true, legalEntityId: true },
      });
      return resolveScoped(ctx, tx, "party_legal_entity_assignment", entityId, visible);
    }
    case "customer_role": {
      const visible = await tx.customerRole.findFirst({
        where: { id: entityId, tenantId: ctx.tenantId },
        select: { id: true, legalEntityId: true },
      });
      return resolveScoped(ctx, tx, "customer_role", entityId, visible);
    }
    case "vendor_role": {
      const visible = await tx.vendorRole.findFirst({
        where: { id: entityId, tenantId: ctx.tenantId },
        select: { id: true, legalEntityId: true },
      });
      return resolveScoped(ctx, tx, "vendor_role", entityId, visible);
    }
    case "catalog_item_legal_entity_assignment": {
      const visible = await tx.catalogItemLegalEntityAssignment.findFirst({
        where: { id: entityId, tenantId: ctx.tenantId },
        select: { id: true, legalEntityId: true },
      });
      return resolveScoped(
        ctx,
        tx,
        "catalog_item_legal_entity_assignment",
        entityId,
        visible,
      );
    }
    case "price_list_legal_entity_assignment": {
      const visible = await tx.priceListLegalEntityAssignment.findFirst({
        where: { id: entityId, tenantId: ctx.tenantId },
        select: { id: true, legalEntityId: true },
      });
      return resolveScoped(
        ctx,
        tx,
        "price_list_legal_entity_assignment",
        entityId,
        visible,
      );
    }
  }
}
