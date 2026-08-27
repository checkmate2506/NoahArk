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
import type { TransactionClient } from "@noahark/db";
import { withTenantContext } from "@noahark/db";
import { writeAuditEvent, auditActorFields } from "./audit";
import { mapPartyDbError } from "./errors";
import { lockPartyRow } from "./locking";
import { maskPartyContact } from "./masking";
import { isEmailShape, normaliseEmail } from "./normalize";
import { isPartyOwner } from "./partyService";
import {
  requireExpectedVersion,
  requireNonEmptyLegalEntityScope,
  tenantContextInput,
} from "./trustedContext";

export const CreateContactSchema = z.object({
  partyId: z.string().min(1).max(64),
  givenName: z.string().trim().min(1).max(200),
  familyName: z.string().trim().min(1).max(200).optional(),
  jobTitle: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().max(320).optional(),
  phone: z.string().trim().max(40).optional(),
  isPrimary: z.boolean().optional(),
});

export const UpdateContactSchema = z.object({
  expectedVersion: z.number().int().min(1),
  givenName: z.string().trim().min(1).max(200).optional(),
  familyName: z.string().trim().min(1).max(200).nullable().optional(),
  jobTitle: z.string().trim().min(1).max(200).nullable().optional(),
  email: z.string().trim().max(320).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  isPrimary: z.boolean().optional(),
});

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid input", { issues: parsed.error.issues });
  }
  return parsed.data;
}

function contactEmail(value: string | null | undefined): {
  email: string | null;
  normalisedEmail: string | null;
} {
  if (value === undefined) {
    return { email: null, normalisedEmail: null };
  }
  if (value === null || value.trim() === "") {
    return { email: null, normalisedEmail: null };
  }
  if (!isEmailShape(value)) {
    throw new ValidationError("Invalid email shape");
  }
  const email = value.trim();
  return { email, normalisedEmail: normaliseEmail(email) };
}

async function requireVisibleOwnedParty(
  tx: TransactionClient,
  ctx: AccessContext,
  partyId: string,
  mutate: boolean,
) {
  const party = await tx.party.findFirst({
    where: { id: partyId, tenantId: ctx.tenantId },
  });
  if (!party) throw new NotFoundError("Party");
  if (mutate && !isPartyOwner(ctx, party)) throw new ForbiddenError("Not permitted");
  return party;
}

export async function createContact(ctx: AccessContext, raw: unknown) {
  const input = parseOrThrow(CreateContactSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  const emailFields = contactEmail(input.email ?? null);

  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      await requireVisibleOwnedParty(tx, ctx, input.partyId, true);
      const locked = await lockPartyRow(tx, ctx.tenantId, input.partyId);
      if (!locked) throw new NotFoundError("Party");
      if (locked.status === "ARCHIVED") {
        throw new ValidationError("Cannot add contacts to an archived party");
      }
      if (input.isPrimary) {
        await tx.partyContact.updateMany({
          where: { tenantId: ctx.tenantId, partyId: input.partyId, isPrimary: true },
          data: { isPrimary: false, updatedAt: new Date() },
        });
      }
      const contact = await tx.partyContact.create({
        data: {
          tenantId: ctx.tenantId,
          partyId: input.partyId,
          givenName: input.givenName,
          familyName: input.familyName ?? null,
          jobTitle: input.jobTitle ?? null,
          email: emailFields.email,
          phone: input.phone ?? null,
          isPrimary: input.isPrimary ?? false,
          normalisedEmail: emailFields.normalisedEmail,
        },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: locked.ownerLegalEntityId,
        action: AUDIT_ACTIONS.PARTY_CONTACT_CREATED,
        entityType: "party_contact",
        entityId: contact.id,
        afterData: {
          id: contact.id,
          partyId: contact.partyId,
          isPrimary: contact.isPrimary,
          version: contact.version,
        },
      });
      return maskPartyContact(ctx, contact, locked.ownerLegalEntityId);
    });
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError
    ) {
      throw error;
    }
    mapPartyDbError(error, "Contact");
  }
}

export async function getContact(ctx: AccessContext, contactId: string) {
  requireNonEmptyLegalEntityScope(ctx);
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const contact = await tx.partyContact.findFirst({
      where: { id: contactId, tenantId: ctx.tenantId },
      include: { party: { select: { ownerLegalEntityId: true } } },
    });
    if (!contact) throw new NotFoundError("Contact");
    const { party, ...row } = contact;
    return maskPartyContact(ctx, row, party.ownerLegalEntityId);
  });
}

export async function listContacts(ctx: AccessContext, partyId: string) {
  requireNonEmptyLegalEntityScope(ctx);
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const party = await tx.party.findFirst({
      where: { id: partyId, tenantId: ctx.tenantId },
    });
    if (!party) throw new NotFoundError("Party");
    const contacts = await tx.partyContact.findMany({
      where: { tenantId: ctx.tenantId, partyId },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    });
    return contacts.map((c) => maskPartyContact(ctx, c, party.ownerLegalEntityId));
  });
}

export async function updateContact(ctx: AccessContext, contactId: string, raw: unknown) {
  const input = parseOrThrow(UpdateContactSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Contact");

  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const existing = await tx.partyContact.findFirst({
        where: { id: contactId, tenantId: ctx.tenantId },
        include: { party: true },
      });
      if (!existing) throw new NotFoundError("Contact");
      if (!isPartyOwner(ctx, existing.party)) throw new ForbiddenError("Not permitted");
      const locked = await lockPartyRow(tx, ctx.tenantId, existing.partyId);
      if (!locked) throw new NotFoundError("Party");
      if (existing.version !== input.expectedVersion) {
        throw new StaleVersionError("Contact");
      }
      if (existing.status === "ARCHIVED") {
        throw new ValidationError("Archived contacts cannot be updated");
      }

      if (input.isPrimary === true) {
        await tx.partyContact.updateMany({
          where: {
            tenantId: ctx.tenantId,
            partyId: existing.partyId,
            isPrimary: true,
            id: { not: contactId },
          },
          data: { isPrimary: false, updatedAt: new Date() },
        });
      }

      const emailFields = input.email === undefined ? null : contactEmail(input.email);

      const updated = await tx.partyContact.updateMany({
        where: { id: contactId, tenantId: ctx.tenantId, version: input.expectedVersion },
        data: {
          ...omitUndefined({
            givenName: input.givenName,
            isPrimary: input.isPrimary,
          }),
          ...(input.familyName !== undefined ? { familyName: input.familyName } : {}),
          ...(input.jobTitle !== undefined ? { jobTitle: input.jobTitle } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(emailFields
            ? { email: emailFields.email, normalisedEmail: emailFields.normalisedEmail }
            : {}),
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Contact");
      const after = await tx.partyContact.findFirstOrThrow({
        where: { id: contactId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: existing.party.ownerLegalEntityId,
        action: AUDIT_ACTIONS.PARTY_CONTACT_UPDATED,
        entityType: "party_contact",
        entityId: after.id,
        beforeData: { version: existing.version, isPrimary: existing.isPrimary },
        afterData: { version: after.version, isPrimary: after.isPrimary },
      });
      return maskPartyContact(ctx, after, existing.party.ownerLegalEntityId);
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
    mapPartyDbError(error, "Contact");
  }
}

export async function archiveContact(
  ctx: AccessContext,
  contactId: string,
  expectedVersion: number,
) {
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(expectedVersion, "Contact");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const existing = await tx.partyContact.findFirst({
        where: { id: contactId, tenantId: ctx.tenantId },
        include: { party: true },
      });
      if (!existing) throw new NotFoundError("Contact");
      if (!isPartyOwner(ctx, existing.party)) throw new ForbiddenError("Not permitted");
      if (existing.version !== expectedVersion) throw new StaleVersionError("Contact");
      if (existing.status === "ARCHIVED") {
        throw new ValidationError("Contact is already archived");
      }
      const archivedAt = new Date();
      const updated = await tx.partyContact.updateMany({
        where: { id: contactId, tenantId: ctx.tenantId, version: expectedVersion },
        data: {
          status: "ARCHIVED",
          archivedAt,
          isPrimary: false,
          version: { increment: 1 },
          updatedAt: archivedAt,
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Contact");
      const after = await tx.partyContact.findFirstOrThrow({
        where: { id: contactId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: existing.party.ownerLegalEntityId,
        action: AUDIT_ACTIONS.PARTY_CONTACT_ARCHIVED,
        entityType: "party_contact",
        entityId: after.id,
        beforeData: { version: existing.version, status: existing.status },
        afterData: { version: after.version, status: after.status },
      });
      return maskPartyContact(ctx, after, existing.party.ownerLegalEntityId);
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
    mapPartyDbError(error, "Contact");
  }
}
