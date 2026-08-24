import { z } from "zod";
import { authorize, PERMISSIONS } from "@noahark/authz";
import {
  type AccessContext,
  NotFoundError,
  assertJurisdictionCurrencyCompatible,
  omitUndefined,
  JURISDICTIONS,
  CURRENCIES,
  LANGUAGES,
} from "@noahark/core";
import { withTenantContext } from "@noahark/db";
import { AUDIT_ACTIONS } from "@noahark/audit";
import { writeAuditEvent } from "./auditService";

export async function listLegalEntities(ctx: AccessContext) {
  authorize(ctx, { permission: PERMISSIONS.LEGAL_ENTITY_READ });
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds },
    (tx) =>
      tx.legalEntity.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: "asc" },
      }),
  );
}

export const CreateLegalEntitySchema = z.object({
  name: z.string().min(1).max(200),
  jurisdiction: z.enum(JURISDICTIONS),
  functionalCurrency: z.enum(CURRENCIES),
  timeZone: z.string().min(1),
  defaultLanguage: z.enum(LANGUAGES).default("EN"),
  registeredIdentifier: z.string().max(100).optional(),
});

export async function createLegalEntity(
  ctx: AccessContext,
  input: z.infer<typeof CreateLegalEntitySchema>,
) {
  authorize(ctx, { permission: PERMISSIONS.LEGAL_ENTITY_CREATE });

  // App-layer mirror of the DB CHECK constraint (LEGAL_ENTITY_ARCHITECTURE.md
  // §2) — both must independently reject a mismatched pairing.
  assertJurisdictionCurrencyCompatible(input.jurisdiction, input.functionalCurrency);

  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      const legalEntity = await tx.legalEntity.create({
        data: {
          tenantId: ctx.tenantId,
          name: input.name,
          jurisdiction: input.jurisdiction,
          functionalCurrency: input.functionalCurrency,
          timeZone: input.timeZone,
          defaultLanguage: input.defaultLanguage,
          ...omitUndefined({ registeredIdentifier: input.registeredIdentifier }),
        },
      });

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.LEGAL_ENTITY_CREATED,
        entityType: "legal_entity",
        entityId: legalEntity.id,
        afterData: legalEntity,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });

      return legalEntity;
    },
  );
}

export const UpdateLegalEntitySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  timeZone: z.string().min(1).optional(),
  defaultLanguage: z.enum(LANGUAGES).optional(),
  registeredIdentifier: z.string().max(100).optional(),
});

export async function updateLegalEntity(
  ctx: AccessContext,
  legalEntityId: string,
  input: z.infer<typeof UpdateLegalEntitySchema>,
) {
  authorize(ctx, { permission: PERMISSIONS.LEGAL_ENTITY_UPDATE, legalEntityId });

  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      const before = await tx.legalEntity.findUnique({ where: { id: legalEntityId } });
      if (!before || before.tenantId !== ctx.tenantId)
        throw new NotFoundError("Legal entity");

      const after = await tx.legalEntity.update({
        where: { id: legalEntityId },
        data: omitUndefined(input),
      });

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        legalEntityId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.LEGAL_ENTITY_UPDATED,
        entityType: "legal_entity",
        entityId: legalEntityId,
        beforeData: before,
        afterData: after,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });

      return after;
    },
  );
}
