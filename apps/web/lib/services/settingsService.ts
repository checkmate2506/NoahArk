import { z } from "zod";
import { authorize, PERMISSIONS } from "@noahark/authz";
import { type AccessContext } from "@noahark/core";
import { withTenantContext } from "@noahark/db";
import {
  validateTenantSettingValue,
  validateLegalEntitySettingValue,
} from "@noahark/config";
import { AUDIT_ACTIONS } from "@noahark/audit";
import { writeAuditEvent } from "./auditService";

export async function listTenantSettings(ctx: AccessContext) {
  authorize(ctx, { permission: PERMISSIONS.SETTINGS_READ });
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds },
    (tx) => tx.tenantSetting.findMany({ where: { tenantId: ctx.tenantId } }),
  );
}

export const UpdateTenantSettingSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
});

export async function updateTenantSetting(
  ctx: AccessContext,
  input: z.infer<typeof UpdateTenantSettingSchema>,
) {
  authorize(ctx, { permission: PERMISSIONS.SETTINGS_UPDATE });
  const validatedValue = validateTenantSettingValue(input.key, input.value);

  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      const before = await tx.tenantSetting.findUnique({
        where: { tenantId_key: { tenantId: ctx.tenantId, key: input.key } },
      });

      const after = await tx.tenantSetting.upsert({
        where: { tenantId_key: { tenantId: ctx.tenantId, key: input.key } },
        create: {
          tenantId: ctx.tenantId,
          key: input.key,
          value: validatedValue as never,
          updatedByUser: ctx.userId,
        },
        update: { value: validatedValue as never, updatedByUser: ctx.userId },
      });

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entityType: "tenant_setting",
        entityId: after.id,
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

export async function listLegalEntitySettings(ctx: AccessContext, legalEntityId: string) {
  authorize(ctx, { permission: PERMISSIONS.SETTINGS_READ, legalEntityId });
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds },
    (tx) =>
      tx.legalEntitySetting.findMany({
        where: { tenantId: ctx.tenantId, legalEntityId },
      }),
  );
}

export const UpdateLegalEntitySettingSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
});

export async function updateLegalEntitySetting(
  ctx: AccessContext,
  legalEntityId: string,
  input: z.infer<typeof UpdateLegalEntitySettingSchema>,
) {
  authorize(ctx, { permission: PERMISSIONS.SETTINGS_UPDATE, legalEntityId });
  const validatedValue = validateLegalEntitySettingValue(input.key, input.value);

  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      const before = await tx.legalEntitySetting.findUnique({
        where: { legalEntityId_key: { legalEntityId, key: input.key } },
      });

      const after = await tx.legalEntitySetting.upsert({
        where: { legalEntityId_key: { legalEntityId, key: input.key } },
        create: {
          tenantId: ctx.tenantId,
          legalEntityId,
          key: input.key,
          value: validatedValue as never,
          updatedByUser: ctx.userId,
        },
        update: { value: validatedValue as never, updatedByUser: ctx.userId },
      });

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        legalEntityId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entityType: "legal_entity_setting",
        entityId: after.id,
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
