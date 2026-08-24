import { z } from "zod";
import {
  authorize,
  assertCanAssignRole,
  PERMISSIONS,
  type PermissionKey,
} from "@noahark/authz";
import {
  type AccessContext,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  omitUndefined,
} from "@noahark/core";
import { withTenantContext } from "@noahark/db";
import { AUDIT_ACTIONS } from "@noahark/audit";
import { writeAuditEvent, writeAuditEventAndOutbox } from "./auditService";

export async function listRoles(ctx: AccessContext) {
  authorize(ctx, { permission: PERMISSIONS.ROLE_READ });
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds },
    (tx) =>
      tx.role.findMany({
        where: { tenantId: ctx.tenantId },
        include: { rolePermissions: { include: { permission: true } } },
        orderBy: { createdAt: "asc" },
      }),
  );
}

export const CreateRoleSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9_]+$/, "lowercase letters, numbers and underscores only"),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  permissionKeys: z.array(z.string()).default([]),
});

export async function createRole(
  ctx: AccessContext,
  input: z.infer<typeof CreateRoleSchema>,
) {
  authorize(ctx, { permission: PERMISSIONS.ROLE_CREATE });

  // A caller can never define a custom role that grants permissions they do
  // not themselves hold — the same no-escalation-via-delegation rule that
  // governs role *assignment* also governs role *creation*.
  const missing = input.permissionKeys.filter((k) => !ctx.permissions.has(k));
  if (missing.length > 0) {
    throw new ForbiddenError(
      "You cannot create a role with permissions you do not hold yourself",
    );
  }

  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      const existing = await tx.role.findUnique({
        where: { tenantId_key: { tenantId: ctx.tenantId, key: input.key } },
      });
      if (existing)
        throw new ConflictError(`A role with key "${input.key}" already exists`);

      const permissions = await tx.permission.findMany({
        where: { key: { in: input.permissionKeys } },
      });

      const role = await tx.role.create({
        data: {
          tenantId: ctx.tenantId,
          key: input.key,
          name: input.name,
          ...omitUndefined({ description: input.description }),
          isSystem: false,
          rolePermissions: {
            create: permissions.map((p) => ({
              tenantId: ctx.tenantId,
              permissionId: p.id,
            })),
          },
        },
        include: { rolePermissions: { include: { permission: true } } },
      });

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.ROLE_CREATED,
        entityType: "role",
        entityId: role.id,
        afterData: role,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });

      return role;
    },
  );
}

export const UpdateRolePermissionsSchema = z.object({
  permissionKeys: z.array(z.string()),
});

export async function updateRolePermissions(
  ctx: AccessContext,
  roleId: string,
  input: z.infer<typeof UpdateRolePermissionsSchema>,
) {
  authorize(ctx, { permission: PERMISSIONS.ROLE_UPDATE });

  const missing = input.permissionKeys.filter((k) => !ctx.permissions.has(k));
  if (missing.length > 0) {
    throw new ForbiddenError("You cannot grant permissions you do not hold yourself");
  }

  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      const role = await tx.role.findUnique({ where: { id: roleId } });
      if (!role || role.tenantId !== ctx.tenantId) throw new NotFoundError("Role");
      if (role.isSystem) {
        throw new ForbiddenError("System roles cannot have their permissions modified");
      }

      const permissions = await tx.permission.findMany({
        where: { key: { in: input.permissionKeys } },
      });

      await tx.rolePermission.deleteMany({ where: { roleId } });
      await tx.rolePermission.createMany({
        data: permissions.map((p) => ({
          tenantId: ctx.tenantId,
          roleId,
          permissionId: p.id,
        })),
      });

      const after = await tx.role.findUniqueOrThrow({
        where: { id: roleId },
        include: { rolePermissions: { include: { permission: true } } },
      });

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.ROLE_UPDATED,
        entityType: "role",
        entityId: roleId,
        beforeData: role,
        afterData: after,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });

      return after;
    },
  );
}

export async function deleteRole(ctx: AccessContext, roleId: string) {
  authorize(ctx, { permission: PERMISSIONS.ROLE_DELETE });

  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      const role = await tx.role.findUnique({ where: { id: roleId } });
      if (!role || role.tenantId !== ctx.tenantId) throw new NotFoundError("Role");
      if (role.isSystem) throw new ForbiddenError("System roles cannot be deleted");

      const inUse = await tx.membershipRole.findFirst({ where: { roleId } });
      if (inUse)
        throw new ConflictError("Cannot delete a role that is currently assigned");

      await tx.rolePermission.deleteMany({ where: { roleId } });
      await tx.role.delete({ where: { id: roleId } });

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.ROLE_DELETED,
        entityType: "role",
        entityId: roleId,
        beforeData: role,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });

      return { id: roleId, deleted: true };
    },
  );
}

export const AssignRoleSchema = z.object({
  tenantMembershipId: z.string().min(1),
  roleId: z.string().min(1),
  legalEntityId: z.string().min(1).nullable().default(null),
});

export async function assignRole(
  ctx: AccessContext,
  input: z.infer<typeof AssignRoleSchema>,
) {
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      const [targetMembership, role] = await Promise.all([
        tx.tenantMembership.findUnique({ where: { id: input.tenantMembershipId } }),
        tx.role.findUnique({
          where: { id: input.roleId },
          include: { rolePermissions: { include: { permission: true } } },
        }),
      ]);
      if (!targetMembership || targetMembership.tenantId !== ctx.tenantId) {
        throw new NotFoundError("Membership");
      }
      if (!role || role.tenantId !== ctx.tenantId) throw new NotFoundError("Role");

      const rolePermissionKeys = role.rolePermissions.map(
        (rp) => rp.permission.key,
      ) as PermissionKey[];

      assertCanAssignRole(ctx, {
        targetUserId: targetMembership.userId,
        rolePermissions: rolePermissionKeys,
        legalEntityId: input.legalEntityId,
      });

      const assignment = await tx.membershipRole.create({
        data: {
          tenantId: ctx.tenantId,
          tenantMembershipId: input.tenantMembershipId,
          roleId: input.roleId,
          legalEntityId: input.legalEntityId,
          assignedByUserId: ctx.userId,
        },
      });

      // F-3D (Phase 1B): a role assignment is exactly the kind of event a
      // later cross-system integration would want to react to (e.g.
      // provisioning access in an external tool) — demonstrated here as
      // the representative writeAuditEventAndOutbox call site. The audit
      // event is the authoritative record either way; the outbox row is
      // an additional, independently-retried delivery queue entry that
      // shares this same transaction (both commit or neither does).
      await writeAuditEventAndOutbox(
        tx,
        {
          tenantId: ctx.tenantId,
          legalEntityId: input.legalEntityId,
          actorUserId: ctx.userId,
          action: AUDIT_ACTIONS.ROLE_ASSIGNED,
          entityType: "membership_role",
          entityId: assignment.id,
          afterData: assignment,
          requestId: ctx.requestId,
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
        },
        {
          eventType: "membership_role.assigned",
          payload: {
            membershipRoleId: assignment.id,
            roleId: input.roleId,
            tenantMembershipId: input.tenantMembershipId,
          },
          legalEntityId: input.legalEntityId,
          correlationId: ctx.requestId,
        },
      );

      return assignment;
    },
  );
}

export async function unassignRole(ctx: AccessContext, assignmentId: string) {
  authorize(ctx, { permission: PERMISSIONS.ROLE_ASSIGN });

  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      const assignment = await tx.membershipRole.findUnique({
        where: { id: assignmentId },
        include: { tenantMembership: true },
      });
      if (!assignment || assignment.tenantId !== ctx.tenantId)
        throw new NotFoundError("Assignment");
      if (assignment.tenantMembership.userId === ctx.userId) {
        throw new ForbiddenError("You cannot change your own role assignment");
      }

      await tx.membershipRole.delete({ where: { id: assignmentId } });

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        legalEntityId: assignment.legalEntityId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.ROLE_UNASSIGNED,
        entityType: "membership_role",
        entityId: assignmentId,
        beforeData: assignment,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });

      return { id: assignmentId, deleted: true };
    },
  );
}
