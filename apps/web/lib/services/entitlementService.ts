import { z } from "zod";
import { authorize, PERMISSIONS } from "@noahark/authz";
import { type AccessContext, ModuleDisabledError } from "@noahark/core";
import { withTenantContext, type TransactionClient } from "@noahark/db";
import { AUDIT_ACTIONS } from "@noahark/audit";
import { writeAuditEvent } from "./auditService";

export const MODULE_KEYS = {
  APPROVALS: "approvals",
  FILES: "files",
} as const;

/** No TenantEntitlement row = not yet configured = enabled by default
 * (an opt-out model, matching TenantSetting/NotificationPreference's own
 * default posture) — a tenant admin explicitly disables a module to gate it.
 *
 * F-17 (Phase 1B): tx-scoped variant, for callers that already hold an open
 * `withTenantContext` transaction (e.g. approvalService.decideApproval) —
 * checking the entitlement in a SEPARATE transaction (the old
 * `assertModuleEnabled` below) meant a module could be disabled by another
 * request in the gap between the check and the caller's own write,
 * genuinely a TOCTOU race, not just a style preference.
 */
export async function assertModuleEnabledTx(
  tx: TransactionClient,
  tenantId: string,
  moduleKey: string,
): Promise<void> {
  const entitlement = await tx.tenantEntitlement.findUnique({
    where: { tenantId_moduleKey: { tenantId, moduleKey } },
  });
  if (!(entitlement?.enabled ?? true)) throw new ModuleDisabledError(moduleKey);
}

/** Convenience wrapper for callers with no already-open transaction. */
export async function assertModuleEnabled(
  ctx: AccessContext,
  moduleKey: string,
): Promise<void> {
  await withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds },
    (tx) => assertModuleEnabledTx(tx, ctx.tenantId, moduleKey),
  );
}

export const SetModuleEnabledSchema = z.object({
  moduleKey: z.enum([MODULE_KEYS.APPROVALS, MODULE_KEYS.FILES]),
  enabled: z.boolean(),
});

export async function setModuleEnabled(
  ctx: AccessContext,
  input: z.infer<typeof SetModuleEnabledSchema>,
) {
  authorize(ctx, { permission: PERMISSIONS.SETTINGS_UPDATE });

  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      const before = await tx.tenantEntitlement.findUnique({
        where: {
          tenantId_moduleKey: { tenantId: ctx.tenantId, moduleKey: input.moduleKey },
        },
      });

      const after = await tx.tenantEntitlement.upsert({
        where: {
          tenantId_moduleKey: { tenantId: ctx.tenantId, moduleKey: input.moduleKey },
        },
        create: {
          tenantId: ctx.tenantId,
          moduleKey: input.moduleKey,
          enabled: input.enabled,
        },
        update: { enabled: input.enabled },
      });

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entityType: "tenant_entitlement",
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

export async function listEntitlements(ctx: AccessContext) {
  authorize(ctx, { permission: PERMISSIONS.SETTINGS_READ });
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds },
    (tx) => tx.tenantEntitlement.findMany({ where: { tenantId: ctx.tenantId } }),
  );
}
