import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { authorize, PERMISSIONS, type PermissionKey } from "@noahark/authz";
import {
  type AccessContext,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
} from "@noahark/core";
import { withTenantContext, withInvitationAcceptContext } from "@noahark/db";
import { AUDIT_ACTIONS } from "@noahark/audit";
import { hashPassword } from "@noahark/auth";
import { writeAuditEvent, writeAuditEventAndOutbox } from "./auditService";
import { createSession, type CreatedSession } from "@/lib/session";
import { getSharedEmailProvider } from "@/lib/testEmailCapture";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export async function listInvitations(ctx: AccessContext) {
  authorize(ctx, { permission: PERMISSIONS.MEMBERSHIP_READ });
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds },
    (tx) =>
      tx.membershipInvitation.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: "desc" },
      }),
  );
}

export const CreateInvitationSchema = z.object({
  email: z.email(),
  intendedRoleId: z.string().min(1).nullable().default(null),
  intendedLegalEntityId: z.string().min(1).nullable().default(null),
});

/**
 * F-3E: creates a membership invitation. The inviter cannot grant a role
 * carrying permissions they do not hold themselves (mirrors
 * assertCanAssignRole's no-escalation-via-delegation rule — checked here at
 * INVITE time; Phase 1 does not re-check at acceptance, since these are
 * short-lived (7-day) invitations, not standing grants), and cannot grant
 * access to a legal entity they were not themselves granted.
 *
 * The raw token is returned ONLY here, alongside the invitation row — like
 * session tokens and demo seed passwords, only its SHA-256 hash is ever
 * persisted.
 */
export async function createInvitation(
  ctx: AccessContext,
  input: z.infer<typeof CreateInvitationSchema>,
): Promise<{
  invitation: { id: string; email: string; expiresAt: Date };
  rawToken: string;
}> {
  authorize(ctx, { permission: PERMISSIONS.MEMBERSHIP_INVITE });

  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      if (input.intendedRoleId) {
        const role = await tx.role.findUnique({
          where: { id: input.intendedRoleId },
          include: { rolePermissions: { include: { permission: true } } },
        });
        if (!role || role.tenantId !== ctx.tenantId) throw new NotFoundError("Role");
        const permKeys = role.rolePermissions.map(
          (rp) => rp.permission.key,
        ) as PermissionKey[];
        const missing = permKeys.filter((k) => !ctx.permissions.has(k));
        if (missing.length > 0) {
          throw new ForbiddenError(
            "You cannot invite someone to a role with permissions you do not hold yourself",
          );
        }
      }

      if (input.intendedLegalEntityId) {
        authorize(ctx, {
          permission: PERMISSIONS.LEGAL_ENTITY_MEMBERSHIP_GRANT,
          legalEntityId: input.intendedLegalEntityId,
        });
      }

      const rawToken = randomBytes(32).toString("base64url");
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

      const invitation = await tx.membershipInvitation.create({
        data: {
          tenantId: ctx.tenantId,
          email: input.email,
          tokenHash,
          invitedByUserId: ctx.userId,
          intendedRoleId: input.intendedRoleId,
          intendedLegalEntityId: input.intendedLegalEntityId,
          expiresAt,
        },
      });

      await writeAuditEventAndOutbox(
        tx,
        {
          tenantId: ctx.tenantId,
          legalEntityId: input.intendedLegalEntityId,
          actorUserId: ctx.userId,
          action: AUDIT_ACTIONS.MEMBERSHIP_INVITATION_CREATED,
          entityType: "membership_invitation",
          entityId: invitation.id,
          afterData: { email: invitation.email, expiresAt: invitation.expiresAt },
          requestId: ctx.requestId,
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
        },
        {
          eventType: "membership_invitation.created",
          payload: { invitationId: invitation.id, email: invitation.email },
          correlationId: ctx.requestId,
        },
      );

      // Dev-safe: logs to console only (EMAIL_PROVIDER is "console"-only in
      // Phase 1 — see packages/config's env schema). The link is never
      // logged with a real base URL baked in; the admin UI shows it too.
      await getSharedEmailProvider().send({
        to: input.email,
        subject: "You've been invited to NoahArk",
        body: `You've been invited to join a NoahArk tenant. Accept: /invitations/accept?token=${rawToken}`,
      });

      return {
        invitation: {
          id: invitation.id,
          email: invitation.email,
          expiresAt: invitation.expiresAt,
        },
        rawToken,
      };
    },
  );
}

export async function revokeInvitation(ctx: AccessContext, invitationId: string) {
  authorize(ctx, { permission: PERMISSIONS.MEMBERSHIP_INVITE });

  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      const before = await tx.membershipInvitation.findUnique({
        where: { id: invitationId },
      });
      if (!before || before.tenantId !== ctx.tenantId)
        throw new NotFoundError("Invitation");
      if (before.status !== "PENDING")
        throw new ConflictError("Only a pending invitation can be revoked");

      const after = await tx.membershipInvitation.update({
        where: { id: invitationId },
        data: { status: "REVOKED", revokedAt: new Date() },
      });

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.MEMBERSHIP_INVITATION_REVOKED,
        entityType: "membership_invitation",
        entityId: invitationId,
        beforeData: { status: before.status },
        afterData: { status: after.status },
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });

      return after;
    },
  );
}

export const AcceptInvitationSchema = z.object({
  token: z.string().min(1),
  // Required only when no User account exists yet for the invited email —
  // an invitation both provisions membership AND (for a brand-new user)
  // sets their initial password in one step, since Phase 1 has no separate
  // self-serve sign-up flow.
  password: z.string().min(12).optional(),
  name: z.string().min(1).max(200).optional(),
});

/**
 * F-3E: accepts an invitation. Generic error messages throughout (never
 * reveal whether a token exists, is expired, or was already used, beyond
 * "invalid or expired invitation") to avoid token-enumeration/status
 * oracles. Returns a fresh session (auto-signs the user in), matching the
 * UX of every other credential-issuing flow in this codebase.
 */
export async function acceptInvitation(
  input: z.infer<typeof AcceptInvitationSchema>,
): Promise<{ session: CreatedSession; tenantId: string }> {
  const tokenHash = hashToken(input.token);

  const invitation = await withInvitationAcceptContext(tokenHash, (tx) =>
    tx.membershipInvitation.findUnique({ where: { tokenHash } }),
  );

  if (
    !invitation ||
    invitation.status !== "PENDING" ||
    invitation.expiresAt < new Date()
  ) {
    throw new ValidationError("Invalid or expired invitation");
  }

  const result = await withTenantContext(
    { tenantId: invitation.tenantId, legalEntityIds: new Set<string>() },
    async (tx) => {
      // User/UserCredential are global identity tables with no RLS — safe
      // to read/write through this same (tenant-scoped) transaction client.
      const existingUser = await tx.user.findUnique({
        where: { email: invitation.email },
        include: { credential: true },
      });

      let userId: string;
      if (existingUser) {
        userId = existingUser.id;
      } else {
        if (!input.password) {
          throw new ValidationError(
            "A password is required to accept this invitation (no existing account found)",
          );
        }
        const created = await tx.user.create({
          data: {
            email: invitation.email,
            name: input.name ?? null,
            emailVerified: new Date(), // accepting a mailed invitation is itself an ownership proof
          },
        });
        await tx.userCredential.create({
          data: {
            userId: created.id,
            passwordHash: await hashPassword(input.password),
            algorithm: "argon2id",
          },
        });
        userId = created.id;
      }

      const membership = await tx.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId: invitation.tenantId, userId } },
        create: {
          tenantId: invitation.tenantId,
          userId,
          status: "ACTIVE",
          invitedByUserId: invitation.invitedByUserId,
        },
        update: { status: "ACTIVE" },
      });

      if (invitation.intendedRoleId) {
        const existingAssignment = await tx.membershipRole.findFirst({
          where: {
            tenantMembershipId: membership.id,
            roleId: invitation.intendedRoleId,
            legalEntityId: null,
          },
        });
        if (!existingAssignment) {
          await tx.membershipRole.create({
            data: {
              tenantId: invitation.tenantId,
              tenantMembershipId: membership.id,
              roleId: invitation.intendedRoleId,
              legalEntityId: null,
              assignedByUserId: invitation.invitedByUserId,
            },
          });
        }
      }

      if (invitation.intendedLegalEntityId) {
        await tx.legalEntityMembership.upsert({
          where: {
            legalEntityId_userId: {
              legalEntityId: invitation.intendedLegalEntityId,
              userId,
            },
          },
          create: {
            tenantId: invitation.tenantId,
            legalEntityId: invitation.intendedLegalEntityId,
            userId,
            status: "ACTIVE",
            grantedByUserId: invitation.invitedByUserId,
          },
          update: { status: "ACTIVE" },
        });
      }

      await tx.membershipInvitation.update({
        where: { id: invitation.id },
        data: { status: "ACCEPTED", acceptedAt: new Date() },
      });

      await writeAuditEvent(tx, {
        tenantId: invitation.tenantId,
        legalEntityId: invitation.intendedLegalEntityId,
        actorUserId: userId,
        action: AUDIT_ACTIONS.MEMBERSHIP_INVITATION_ACCEPTED,
        entityType: "membership_invitation",
        entityId: invitation.id,
        afterData: { email: invitation.email },
      });

      return { userId, tenantId: invitation.tenantId };
    },
  );

  // createSession() uses the SHARED identity client (getIdentityClient()),
  // a connection independent of the transaction above — it must run only
  // AFTER that transaction has committed, or (for a brand-new user) the
  // FK from session.user_id would reference a row not yet visible outside
  // that transaction.
  const session = await createSession(result.userId);
  return { session, tenantId: result.tenantId };
}
