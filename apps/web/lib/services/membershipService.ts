import { z } from "zod";
import { authorize, assertCanGrantLegalEntityAccess, PERMISSIONS } from "@noahark/authz";
import { type AccessContext, NotFoundError, ConflictError } from "@noahark/core";
import { withTenantContext } from "@noahark/db";
import { AUDIT_ACTIONS } from "@noahark/audit";
import { writeAuditEvent } from "./auditService";

export async function listMemberships(ctx: AccessContext) {
  authorize(ctx, { permission: PERMISSIONS.MEMBERSHIP_READ });
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds },
    (tx) =>
      tx.tenantMembership.findMany({
        where: { tenantId: ctx.tenantId },
        include: {
          user: { select: { id: true, email: true, name: true, isDisabled: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
  );
}

export const UpdateMembershipStatusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED"]),
});

export async function updateMembershipStatus(
  ctx: AccessContext,
  membershipId: string,
  input: z.infer<typeof UpdateMembershipStatusSchema>,
) {
  authorize(ctx, { permission: PERMISSIONS.MEMBERSHIP_UPDATE });

  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      const before = await tx.tenantMembership.findUnique({
        where: { id: membershipId },
      });
      if (!before || before.tenantId !== ctx.tenantId)
        throw new NotFoundError("Membership");
      if (before.userId === ctx.userId) {
        throw new ConflictError("You cannot change your own membership status");
      }

      const after = await tx.tenantMembership.update({
        where: { id: membershipId },
        data: { status: input.status },
      });

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.TENANT_MEMBERSHIP_UPDATED,
        entityType: "tenant_membership",
        entityId: membershipId,
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

export async function listLegalEntityMemberships(
  ctx: AccessContext,
  legalEntityId: string,
) {
  authorize(ctx, { permission: PERMISSIONS.LEGAL_ENTITY_MEMBERSHIP_READ, legalEntityId });
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds },
    (tx) =>
      tx.legalEntityMembership.findMany({
        where: { tenantId: ctx.tenantId, legalEntityId },
        include: { user: { select: { id: true, email: true, name: true } } },
        orderBy: { createdAt: "asc" },
      }),
  );
}

export const GrantLegalEntityAccessSchema = z.object({
  userId: z.string().min(1),
});

/** Grants a user access to a legal entity. `assertCanGrantLegalEntityAccess`
 * performs the module-permission check AND rejects self-grants — a user can
 * never expand their own legal-entity access, only someone else's. */
export async function grantLegalEntityAccess(
  ctx: AccessContext,
  legalEntityId: string,
  input: z.infer<typeof GrantLegalEntityAccessSchema>,
) {
  assertCanGrantLegalEntityAccess(ctx, { targetUserId: input.userId, legalEntityId });

  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      const targetMembership = await tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId: ctx.tenantId, userId: input.userId } },
      });
      if (!targetMembership || targetMembership.status !== "ACTIVE") {
        throw new ConflictError("Target user is not an active member of this tenant");
      }

      const grant = await tx.legalEntityMembership.upsert({
        where: { legalEntityId_userId: { legalEntityId, userId: input.userId } },
        create: {
          tenantId: ctx.tenantId,
          legalEntityId,
          userId: input.userId,
          status: "ACTIVE",
          grantedByUserId: ctx.userId,
        },
        update: { status: "ACTIVE", grantedByUserId: ctx.userId },
      });

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        legalEntityId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.LEGAL_ENTITY_MEMBERSHIP_GRANTED,
        entityType: "legal_entity_membership",
        entityId: grant.id,
        afterData: grant,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });

      return grant;
    },
  );
}

export async function revokeLegalEntityAccess(
  ctx: AccessContext,
  legalEntityId: string,
  targetUserId: string,
) {
  authorize(ctx, {
    permission: PERMISSIONS.LEGAL_ENTITY_MEMBERSHIP_REVOKE,
    legalEntityId,
  });
  if (targetUserId === ctx.userId) {
    throw new ConflictError("You cannot revoke your own legal-entity access");
  }

  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      const before = await tx.legalEntityMembership.findUnique({
        where: { legalEntityId_userId: { legalEntityId, userId: targetUserId } },
      });
      if (!before || before.tenantId !== ctx.tenantId) {
        throw new NotFoundError("Legal-entity access grant");
      }

      const after = await tx.legalEntityMembership.update({
        where: { id: before.id },
        data: { status: "SUSPENDED" },
      });

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        legalEntityId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.LEGAL_ENTITY_MEMBERSHIP_REVOKED,
        entityType: "legal_entity_membership",
        entityId: before.id,
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
