import { z } from "zod";
import { authorize, PERMISSIONS } from "@noahark/authz";
import type { AccessContext } from "@noahark/core";
import { NotFoundError, omitUndefined } from "@noahark/core";
import { withTenantContext } from "@noahark/db";
import { AUDIT_ACTIONS } from "@noahark/audit";
import { writeAuditEvent } from "./auditService";

export async function getTenant(ctx: AccessContext) {
  authorize(ctx, { permission: PERMISSIONS.TENANT_READ });
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds },
    async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: ctx.tenantId } });
      if (!tenant) throw new NotFoundError("Tenant");
      return tenant;
    },
  );
}

export const UpdateTenantSchema = z.object({
  name: z.string().min(1).max(200).optional(),
});

export async function updateTenant(
  ctx: AccessContext,
  input: z.infer<typeof UpdateTenantSchema>,
) {
  authorize(ctx, { permission: PERMISSIONS.TENANT_UPDATE });

  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      const before = await tx.tenant.findUnique({ where: { id: ctx.tenantId } });
      if (!before) throw new NotFoundError("Tenant");

      const after = await tx.tenant.update({
        where: { id: ctx.tenantId },
        data: omitUndefined(input),
      });

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.TENANT_UPDATED,
        entityType: "tenant",
        entityId: ctx.tenantId,
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
