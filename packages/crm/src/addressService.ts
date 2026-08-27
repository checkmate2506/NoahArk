import { z } from "zod";
import { AUDIT_ACTIONS } from "@noahark/audit";
import {
  ForbiddenError,
  NotFoundError,
  StaleVersionError,
  ValidationError,
  omitUndefined,
  type AccessContext,
} from "@noahark/core";
import { withTenantContext } from "@noahark/db";
import { writeAuditEvent, auditActorFields } from "./audit";
import { mapPartyDbError } from "./errors";
import { lockPartyRow } from "./locking";
import { isPartyOwner } from "./partyService";
import {
  requireExpectedVersion,
  requireNonEmptyLegalEntityScope,
  tenantContextInput,
} from "./trustedContext";

const COUNTRY_SHAPE = /^[A-Z]{2}$/;

export const CreateAddressSchema = z.object({
  partyId: z.string().min(1).max(64),
  addressType: z.enum(["BILLING", "SHIPPING", "REGISTERED", "GENERAL"]),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().min(1).max(200).optional(),
  line3: z.string().trim().min(1).max(200).optional(),
  city: z.string().trim().min(1).max(100).optional(),
  region: z.string().trim().min(1).max(100).optional(),
  postalCode: z.string().trim().min(1).max(20).optional(),
  countryCode: z.string().regex(COUNTRY_SHAPE),
});

export const UpdateAddressSchema = z.object({
  expectedVersion: z.number().int().min(1),
  addressType: z.enum(["BILLING", "SHIPPING", "REGISTERED", "GENERAL"]).optional(),
  line1: z.string().trim().min(1).max(200).optional(),
  line2: z.string().trim().min(1).max(200).nullable().optional(),
  line3: z.string().trim().min(1).max(200).nullable().optional(),
  city: z.string().trim().min(1).max(100).nullable().optional(),
  region: z.string().trim().min(1).max(100).nullable().optional(),
  postalCode: z.string().trim().min(1).max(20).nullable().optional(),
  countryCode: z.string().regex(COUNTRY_SHAPE).optional(),
});

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid input", { issues: parsed.error.issues });
  }
  return parsed.data;
}

export async function createAddress(ctx: AccessContext, raw: unknown) {
  const input = parseOrThrow(CreateAddressSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const party = await tx.party.findFirst({
        where: { id: input.partyId, tenantId: ctx.tenantId },
      });
      if (!party) throw new NotFoundError("Party");
      if (!isPartyOwner(ctx, party)) throw new ForbiddenError("Not permitted");
      const locked = await lockPartyRow(tx, ctx.tenantId, input.partyId);
      if (!locked) throw new NotFoundError("Party");
      if (locked.status === "ARCHIVED") {
        throw new ValidationError("Cannot add addresses to an archived party");
      }
      const address = await tx.partyAddress.create({
        data: {
          tenantId: ctx.tenantId,
          partyId: input.partyId,
          addressType: input.addressType,
          line1: input.line1,
          line2: input.line2 ?? null,
          line3: input.line3 ?? null,
          city: input.city ?? null,
          region: input.region ?? null,
          postalCode: input.postalCode ?? null,
          countryCode: input.countryCode,
        },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: locked.ownerLegalEntityId,
        action: AUDIT_ACTIONS.PARTY_ADDRESS_CREATED,
        entityType: "party_address",
        entityId: address.id,
        afterData: {
          id: address.id,
          partyId: address.partyId,
          addressType: address.addressType,
          version: address.version,
        },
      });
      return address;
    });
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError
    ) {
      throw error;
    }
    mapPartyDbError(error, "Address");
  }
}

export async function getAddress(ctx: AccessContext, addressId: string) {
  requireNonEmptyLegalEntityScope(ctx);
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const address = await tx.partyAddress.findFirst({
      where: { id: addressId, tenantId: ctx.tenantId },
    });
    if (!address) throw new NotFoundError("Address");
    return address;
  });
}

export async function listAddresses(ctx: AccessContext, partyId: string) {
  requireNonEmptyLegalEntityScope(ctx);
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const party = await tx.party.findFirst({
      where: { id: partyId, tenantId: ctx.tenantId },
    });
    if (!party) throw new NotFoundError("Party");
    return tx.partyAddress.findMany({
      where: { tenantId: ctx.tenantId, partyId },
      orderBy: { createdAt: "asc" },
    });
  });
}

export async function updateAddress(ctx: AccessContext, addressId: string, raw: unknown) {
  const input = parseOrThrow(UpdateAddressSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Address");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const existing = await tx.partyAddress.findFirst({
        where: { id: addressId, tenantId: ctx.tenantId },
        include: { party: true },
      });
      if (!existing) throw new NotFoundError("Address");
      if (!isPartyOwner(ctx, existing.party)) throw new ForbiddenError("Not permitted");
      if (existing.version !== input.expectedVersion) {
        throw new StaleVersionError("Address");
      }
      if (existing.status === "ARCHIVED") {
        throw new ValidationError("Archived addresses cannot be updated");
      }
      const updated = await tx.partyAddress.updateMany({
        where: { id: addressId, tenantId: ctx.tenantId, version: input.expectedVersion },
        data: {
          ...omitUndefined({
            addressType: input.addressType,
            line1: input.line1,
            countryCode: input.countryCode,
          }),
          ...(input.line2 !== undefined ? { line2: input.line2 } : {}),
          ...(input.line3 !== undefined ? { line3: input.line3 } : {}),
          ...(input.city !== undefined ? { city: input.city } : {}),
          ...(input.region !== undefined ? { region: input.region } : {}),
          ...(input.postalCode !== undefined ? { postalCode: input.postalCode } : {}),
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Address");
      const after = await tx.partyAddress.findFirstOrThrow({
        where: { id: addressId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: existing.party.ownerLegalEntityId,
        action: AUDIT_ACTIONS.PARTY_ADDRESS_UPDATED,
        entityType: "party_address",
        entityId: after.id,
        beforeData: { version: existing.version },
        afterData: { version: after.version },
      });
      return after;
    });
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError ||
      error instanceof StaleVersionError
    ) {
      throw error;
    }
    mapPartyDbError(error, "Address");
  }
}

export async function archiveAddress(
  ctx: AccessContext,
  addressId: string,
  expectedVersion: number,
) {
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(expectedVersion, "Address");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const existing = await tx.partyAddress.findFirst({
        where: { id: addressId, tenantId: ctx.tenantId },
        include: { party: true },
      });
      if (!existing) throw new NotFoundError("Address");
      if (!isPartyOwner(ctx, existing.party)) throw new ForbiddenError("Not permitted");
      if (existing.version !== expectedVersion) throw new StaleVersionError("Address");
      if (existing.status === "ARCHIVED") {
        throw new ValidationError("Address is already archived");
      }
      const archivedAt = new Date();
      const updated = await tx.partyAddress.updateMany({
        where: { id: addressId, tenantId: ctx.tenantId, version: expectedVersion },
        data: {
          status: "ARCHIVED",
          archivedAt,
          version: { increment: 1 },
          updatedAt: archivedAt,
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Address");
      const after = await tx.partyAddress.findFirstOrThrow({
        where: { id: addressId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: existing.party.ownerLegalEntityId,
        action: AUDIT_ACTIONS.PARTY_ADDRESS_ARCHIVED,
        entityType: "party_address",
        entityId: after.id,
        beforeData: { version: existing.version, status: existing.status },
        afterData: { version: after.version, status: after.status },
      });
      return after;
    });
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError ||
      error instanceof StaleVersionError
    ) {
      throw error;
    }
    mapPartyDbError(error, "Address");
  }
}
