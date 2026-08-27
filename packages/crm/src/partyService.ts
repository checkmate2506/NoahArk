import { z } from "zod";
import { AUDIT_ACTIONS } from "@noahark/audit";
import {
  isAppError,
  ForbiddenError,
  NotFoundError,
  StaleVersionError,
  ValidationError,
  omitUndefined,
  type AccessContext,
} from "@noahark/core";
import { CURRENCIES } from "@noahark/core";
import { withTenantContext, type Party } from "@noahark/db";
import { writeAuditEvent, auditActorFields } from "./audit";
import { findDuplicateCandidates, type DuplicateCandidate } from "./duplicates";
import { mapPartyDbError } from "./errors";
import { lockPartyAssignments, lockPartyRow } from "./locking";
import { normaliseText, partyDisplayName } from "./normalize";
import {
  boundPageSize,
  decodeCreatedAtIdCursor,
  encodeCreatedAtIdCursor,
} from "./pagination";
import { insertCustomerRole, insertVendorRole } from "./roleRows";
import {
  assertHasLegalEntityAccess,
  requireExpectedVersion,
  requireNonEmptyLegalEntityScope,
  tenantContextInput,
} from "./trustedContext";

const RoleSeedSchema = z.object({
  code: z.string().trim().min(1).max(64),
  defaultCurrency: z.enum(CURRENCIES).optional(),
});

export const CreatePartySchema = z
  .object({
    ownerLegalEntityId: z.string().min(1).max(64),
    code: z.string().trim().min(1).max(64),
    partyType: z.enum(["ORGANISATION", "INDIVIDUAL"]),
    legalName: z.string().trim().min(1).max(200).optional(),
    tradingName: z.string().trim().min(1).max(200).optional(),
    givenName: z.string().trim().min(1).max(200).optional(),
    familyName: z.string().trim().min(1).max(200).optional(),
    taxIdentifier: z.string().trim().min(1).max(64).optional(),
    customerRole: RoleSeedSchema.optional(),
    vendorRole: RoleSeedSchema.optional(),
    contactEmailForDuplicateCheck: z.string().trim().max(320).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.partyType === "ORGANISATION") {
      if (!value.legalName) {
        ctx.addIssue({
          code: "custom",
          message: "Organisation parties require legalName",
          path: ["legalName"],
        });
      }
      if (value.givenName || value.familyName) {
        ctx.addIssue({
          code: "custom",
          message: "Organisation parties cannot have givenName or familyName",
          path: ["givenName"],
        });
      }
    } else {
      if (!value.givenName) {
        ctx.addIssue({
          code: "custom",
          message: "Individual parties require givenName",
          path: ["givenName"],
        });
      }
      if (value.legalName || value.tradingName) {
        ctx.addIssue({
          code: "custom",
          message: "Individual parties cannot have legalName or tradingName",
          path: ["legalName"],
        });
      }
    }
  });

export const UpdatePartySchema = z.object({
  expectedVersion: z.number().int().min(1),
  legalName: z.string().trim().min(1).max(200).optional(),
  tradingName: z.string().trim().min(1).max(200).nullable().optional(),
  givenName: z.string().trim().min(1).max(200).optional(),
  familyName: z.string().trim().min(1).max(200).nullable().optional(),
  taxIdentifier: z.string().trim().min(1).max(64).nullable().optional(),
  code: z.string().trim().min(1).max(64).optional(),
});

export const ListPartiesSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().optional(),
  partyType: z.enum(["ORGANISATION", "INDIVIDUAL"]).optional(),
  status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
  includeArchived: z.boolean().optional(),
  q: z.string().trim().max(200).optional(),
});

export const TransferPartyOwnershipSchema = z.object({
  newOwnerLegalEntityId: z.string().min(1).max(64),
  expectedVersion: z.number().int().min(1),
});

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid input", { issues: parsed.error.issues });
  }
  return parsed.data;
}

function canMutateOwner(ctx: AccessContext, ownerLegalEntityId: string): boolean {
  return ctx.legalEntityIds.has(ownerLegalEntityId);
}

export async function createParty(ctx: AccessContext, raw: unknown) {
  const input = parseOrThrow(CreatePartySchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  assertHasLegalEntityAccess(ctx, input.ownerLegalEntityId);

  const normalisedName = normaliseText(
    partyDisplayName({
      partyType: input.partyType,
      legalName: input.legalName,
      givenName: input.givenName,
      familyName: input.familyName,
    }),
  );
  if (!normalisedName) {
    throw new ValidationError("Party name cannot be blank");
  }

  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const party = await tx.party.create({
        data: {
          tenantId: ctx.tenantId,
          ownerLegalEntityId: input.ownerLegalEntityId,
          code: input.code,
          partyType: input.partyType,
          legalName:
            input.partyType === "ORGANISATION" ? (input.legalName ?? null) : null,
          tradingName:
            input.partyType === "ORGANISATION" ? (input.tradingName ?? null) : null,
          givenName: input.partyType === "INDIVIDUAL" ? (input.givenName ?? null) : null,
          familyName:
            input.partyType === "INDIVIDUAL" ? (input.familyName ?? null) : null,
          normalisedName,
          taxIdentifier: input.taxIdentifier ?? null,
        },
      });

      const assignment = await tx.partyLegalEntityAssignment.create({
        data: {
          tenantId: ctx.tenantId,
          partyId: party.id,
          legalEntityId: input.ownerLegalEntityId,
        },
      });

      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: input.ownerLegalEntityId,
        action: AUDIT_ACTIONS.PARTY_CREATED,
        entityType: "party",
        entityId: party.id,
        afterData: {
          id: party.id,
          code: party.code,
          partyType: party.partyType,
          ownerLegalEntityId: party.ownerLegalEntityId,
          version: party.version,
        },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: input.ownerLegalEntityId,
        action: AUDIT_ACTIONS.PARTY_ASSIGNMENT_CREATED,
        entityType: "party_legal_entity_assignment",
        entityId: assignment.id,
        afterData: {
          id: assignment.id,
          partyId: assignment.partyId,
          legalEntityId: assignment.legalEntityId,
          status: assignment.status,
          version: assignment.version,
        },
      });

      const customerRole = input.customerRole
        ? await insertCustomerRole(tx, ctx, {
            assignmentId: assignment.id,
            legalEntityId: input.ownerLegalEntityId,
            code: input.customerRole.code,
            defaultCurrency: input.customerRole.defaultCurrency,
          })
        : null;
      const vendorRole = input.vendorRole
        ? await insertVendorRole(tx, ctx, {
            assignmentId: assignment.id,
            legalEntityId: input.ownerLegalEntityId,
            code: input.vendorRole.code,
            defaultCurrency: input.vendorRole.defaultCurrency,
          })
        : null;

      const duplicateCandidates = await findDuplicateCandidates(tx, ctx, {
        normalisedName,
        taxIdentifier: input.taxIdentifier,
        contactEmail: input.contactEmailForDuplicateCheck,
        excludePartyId: party.id,
      });

      return {
        party,
        assignment,
        customerRole,
        vendorRole,
        duplicateCandidates,
      };
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    mapPartyDbError(error, "Party");
  }
}

export async function getParty(ctx: AccessContext, partyId: string) {
  requireNonEmptyLegalEntityScope(ctx);
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const party = await tx.party.findFirst({
      where: { id: partyId, tenantId: ctx.tenantId },
    });
    if (!party) throw new NotFoundError("Party");
    return party;
  });
}

export async function listParties(ctx: AccessContext, raw: unknown = {}) {
  const input = parseOrThrow(ListPartiesSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  const limit = boundPageSize(input.limit);
  const cursor = input.cursor ? decodeCreatedAtIdCursor(input.cursor) : null;
  const status = input.status ?? (input.includeArchived ? undefined : "ACTIVE");
  const q = input.q ? normaliseText(input.q) : "";

  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const rows = await tx.party.findMany({
      where: {
        tenantId: ctx.tenantId,
        ...(status ? { status } : {}),
        ...(input.partyType ? { partyType: input.partyType } : {}),
        ...(q ? { normalisedName: { startsWith: q } } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      parties: page,
      nextCursor:
        hasMore && last ? encodeCreatedAtIdCursor(last.createdAt, last.id) : null,
    };
  });
}

export async function updateParty(ctx: AccessContext, partyId: string, raw: unknown) {
  const input = parseOrThrow(UpdatePartySchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Party");

  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const before = await tx.party.findFirst({
        where: { id: partyId, tenantId: ctx.tenantId },
      });
      if (!before) throw new NotFoundError("Party");
      if (!canMutateOwner(ctx, before.ownerLegalEntityId)) {
        throw new ForbiddenError("Not permitted");
      }
      const locked = await lockPartyRow(tx, ctx.tenantId, partyId);
      if (!locked) throw new NotFoundError("Party");
      if (before.version !== input.expectedVersion) {
        throw new StaleVersionError("Party");
      }
      if (before.status === "ARCHIVED") {
        throw new ValidationError("Archived parties cannot be updated");
      }

      const nextType = before.partyType;
      const nextLegal = input.legalName ?? before.legalName;
      const nextGiven = input.givenName ?? before.givenName;
      const nextFamily =
        input.familyName === undefined ? before.familyName : input.familyName;
      const normalisedName = normaliseText(
        partyDisplayName({
          partyType: nextType,
          legalName: nextLegal,
          givenName: nextGiven,
          familyName: nextFamily,
        }),
      );

      const updated = await tx.party.updateMany({
        where: {
          id: partyId,
          tenantId: ctx.tenantId,
          version: input.expectedVersion,
        },
        data: {
          ...omitUndefined({
            code: input.code,
            legalName: input.legalName,
            givenName: input.givenName,
          }),
          ...(input.tradingName !== undefined ? { tradingName: input.tradingName } : {}),
          ...(input.familyName !== undefined ? { familyName: input.familyName } : {}),
          ...(input.taxIdentifier !== undefined
            ? { taxIdentifier: input.taxIdentifier }
            : {}),
          normalisedName,
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Party");

      const after = await tx.party.findFirstOrThrow({
        where: { id: partyId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: after.ownerLegalEntityId,
        action: AUDIT_ACTIONS.PARTY_UPDATED,
        entityType: "party",
        entityId: after.id,
        beforeData: { version: before.version, code: before.code },
        afterData: { version: after.version, code: after.code },
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
    mapPartyDbError(error, "Party");
  }
}

export async function archiveParty(
  ctx: AccessContext,
  partyId: string,
  expectedVersion: number,
) {
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(expectedVersion, "Party");

  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const before = await tx.party.findFirst({
        where: { id: partyId, tenantId: ctx.tenantId },
      });
      if (!before) throw new NotFoundError("Party");
      if (!canMutateOwner(ctx, before.ownerLegalEntityId)) {
        throw new ForbiddenError("Not permitted");
      }
      const locked = await lockPartyRow(tx, ctx.tenantId, partyId);
      if (!locked) throw new NotFoundError("Party");
      if (before.version !== expectedVersion) throw new StaleVersionError("Party");
      if (before.status === "ARCHIVED") {
        throw new ValidationError("Party is already archived");
      }

      const archivedAt = new Date();
      const updated = await tx.party.updateMany({
        where: { id: partyId, tenantId: ctx.tenantId, version: expectedVersion },
        data: {
          status: "ARCHIVED",
          archivedAt,
          version: { increment: 1 },
          updatedAt: archivedAt,
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Party");
      const after = await tx.party.findFirstOrThrow({
        where: { id: partyId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: after.ownerLegalEntityId,
        action: AUDIT_ACTIONS.PARTY_ARCHIVED,
        entityType: "party",
        entityId: after.id,
        beforeData: { version: before.version, status: before.status },
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
    mapPartyDbError(error, "Party");
  }
}

export async function transferPartyOwnership(
  ctx: AccessContext,
  partyId: string,
  raw: unknown,
) {
  const input = parseOrThrow(TransferPartyOwnershipSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Party");
  if (input.newOwnerLegalEntityId === undefined) {
    throw new ValidationError("newOwnerLegalEntityId is required");
  }

  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      await lockPartyAssignments(tx, ctx.tenantId, partyId);
      const before = await tx.party.findFirst({
        where: { id: partyId, tenantId: ctx.tenantId },
      });
      if (!before) throw new NotFoundError("Party");
      if (before.version !== input.expectedVersion) {
        throw new StaleVersionError("Party");
      }
      if (before.status === "ARCHIVED") {
        throw new ValidationError("Archived parties cannot transfer ownership");
      }
      if (!canMutateOwner(ctx, before.ownerLegalEntityId)) {
        throw new ForbiddenError("Not permitted");
      }
      if (input.newOwnerLegalEntityId === before.ownerLegalEntityId) {
        throw new ValidationError("New owner must differ from the current owner");
      }
      if (!ctx.legalEntityIds.has(input.newOwnerLegalEntityId)) {
        throw new ForbiddenError("Not permitted");
      }
      const locked = await lockPartyRow(tx, ctx.tenantId, partyId);
      if (!locked) throw new NotFoundError("Party");

      const now = new Date();
      const updated = await tx.party.updateMany({
        where: { id: partyId, tenantId: ctx.tenantId, version: input.expectedVersion },
        data: {
          ownerLegalEntityId: input.newOwnerLegalEntityId,
          version: { increment: 1 },
          updatedAt: now,
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Party");
      const after = await tx.party.findFirstOrThrow({
        where: { id: partyId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: after.ownerLegalEntityId,
        action: AUDIT_ACTIONS.PARTY_OWNERSHIP_TRANSFERRED,
        entityType: "party",
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
    if (
      error instanceof ValidationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError ||
      error instanceof StaleVersionError
    ) {
      throw error;
    }
    mapPartyDbError(error, "Party");
  }
}

export async function listDuplicateCandidates(
  ctx: AccessContext,
  raw: {
    normalisedName?: string;
    legalName?: string;
    givenName?: string;
    familyName?: string;
    partyType?: "ORGANISATION" | "INDIVIDUAL";
    taxIdentifier?: string | null;
    contactEmail?: string | null;
    excludePartyId?: string;
  },
): Promise<DuplicateCandidate[]> {
  requireNonEmptyLegalEntityScope(ctx);
  const name =
    raw.normalisedName ??
    partyDisplayName({
      partyType: raw.partyType ?? "ORGANISATION",
      legalName: raw.legalName,
      givenName: raw.givenName,
      familyName: raw.familyName,
    });
  return withTenantContext(tenantContextInput(ctx), (tx) =>
    findDuplicateCandidates(tx, ctx, {
      normalisedName: name,
      taxIdentifier: raw.taxIdentifier,
      contactEmail: raw.contactEmail,
      excludePartyId: raw.excludePartyId,
    }),
  );
}

export function isPartyOwner(
  ctx: AccessContext,
  party: Pick<Party, "ownerLegalEntityId">,
) {
  return canMutateOwner(ctx, party.ownerLegalEntityId);
}
