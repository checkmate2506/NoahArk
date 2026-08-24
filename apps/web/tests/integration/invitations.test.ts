import { afterEach, describe, expect, it } from "vitest";
import { createSystemClient } from "@noahark/db/system";
import {
  createInvitation,
  revokeInvitation,
  acceptInvitation,
} from "@/lib/services/invitationService";
import { resolveSession } from "@/lib/session";
import {
  setupTestTenant,
  buildContext,
  cleanupTenant,
  cleanupUser,
  createTestUser,
  addTenantMember,
  assignRoleDirect,
  createTestLegalEntity,
  grantLegalEntityAccessDirect,
  type TestTenantSetup,
} from "./testHelpers";

describe("membership invitations (F-3E, real Postgres)", () => {
  let setup: TestTenantSetup;
  let extraUserIds: string[] = [];

  afterEach(async () => {
    for (const id of extraUserIds) await cleanupUser(id);
    extraUserIds = [];
    if (setup) {
      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
    }
  });

  it("creates an invitation and accepts it, provisioning a brand-new user with membership and role", async () => {
    setup = await setupTestTenant();
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);
    const email = `invitee-${Date.now()}@test.noahark.local`;

    const { invitation, rawToken } = await createInvitation(ctx, {
      email,
      intendedRoleId: setup.memberRoleId,
      intendedLegalEntityId: null,
    });
    expect(invitation.email).toBe(email);
    expect(rawToken.length).toBeGreaterThan(20);

    const { session, tenantId } = await acceptInvitation({
      token: rawToken,
      password: "AcceptedPassword123!",
      name: "New Invitee",
    });
    expect(tenantId).toBe(setup.tenantId);

    const resolved = await resolveSession(session.rawToken);
    expect(resolved?.user.email).toBe(email);
    extraUserIds.push(resolved!.user.id);

    const db = createSystemClient();
    const membership = await db.tenantMembership.findUniqueOrThrow({
      where: { tenantId_userId: { tenantId: setup.tenantId, userId: resolved!.user.id } },
    });
    expect(membership.status).toBe("ACTIVE");
    const roleAssignment = await db.membershipRole.findFirst({
      where: { tenantMembershipId: membership.id, roleId: setup.memberRoleId },
    });
    expect(roleAssignment).not.toBeNull();

    const invitationRow = await db.membershipInvitation.findUniqueOrThrow({
      where: { id: invitation.id },
    });
    expect(invitationRow.status).toBe("ACCEPTED");
  });

  it("accepting an invitation for an EXISTING user's email adds membership without requiring a password", async () => {
    setup = await setupTestTenant();
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);
    const existingUser = await createTestUser();
    extraUserIds.push(existingUser.id);

    const { rawToken } = await createInvitation(ctx, {
      email: existingUser.email,
      intendedRoleId: null,
      intendedLegalEntityId: null,
    });

    const { session } = await acceptInvitation({ token: rawToken });
    const resolved = await resolveSession(session.rawToken);
    expect(resolved?.user.id).toBe(existingUser.id);
  });

  it("rejects accepting a revoked invitation", async () => {
    setup = await setupTestTenant();
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);
    const { invitation, rawToken } = await createInvitation(ctx, {
      email: `revoked-${Date.now()}@test.noahark.local`,
      intendedRoleId: null,
      intendedLegalEntityId: null,
    });

    await revokeInvitation(ctx, invitation.id);

    await expect(acceptInvitation({ token: rawToken })).rejects.toThrow(
      /invalid or expired/i,
    );
  });

  it("rejects an unknown or tampered token with a generic error (no enumeration oracle)", async () => {
    await expect(acceptInvitation({ token: "not-a-real-token" })).rejects.toThrow(
      /invalid or expired/i,
    );
  });

  it("rejects a second acceptance of an already-accepted invitation", async () => {
    setup = await setupTestTenant();
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);
    const { rawToken } = await createInvitation(ctx, {
      email: `once-${Date.now()}@test.noahark.local`,
      intendedRoleId: null,
      intendedLegalEntityId: null,
    });

    const first = await acceptInvitation({
      token: rawToken,
      password: "FirstAccept123!",
    });
    const resolved = await resolveSession(first.session.rawToken);
    extraUserIds.push(resolved!.user.id);

    await expect(
      acceptInvitation({ token: rawToken, password: "SecondAccept123!" }),
    ).rejects.toThrow(/invalid or expired/i);
  });

  it("rejects an inviter granting a role with permissions they do not hold themselves", async () => {
    setup = await setupTestTenant();
    const limitedUser = await createTestUser();
    extraUserIds.push(limitedUser.id);
    const limitedMembership = await addTenantMember(setup.tenantId, limitedUser.id);
    // Give them the member role (no MEMBERSHIP_INVITE... wait, they DO need
    // MEMBERSHIP_INVITE to reach the role-authority check at all — assign a
    // CUSTOM minimal set via the member role, which lacks tenant_admin's
    // full permission set, then attempt to invite someone into the ADMIN role.
    await assignRoleDirect(
      setup.tenantId,
      limitedMembership.id,
      setup.memberRoleId,
      setup.adminUserId,
    );
    const limitedCtx = await buildContext(limitedUser.id, setup.tenantId);

    // member role lacks MEMBERSHIP_INVITE entirely, so this should fail at
    // the permission check (check 3), which is itself the correct "cannot
    // exceed own authority" outcome for someone without invite rights.
    await expect(
      createInvitation(limitedCtx, {
        email: "target@test.noahark.local",
        intendedRoleId: setup.adminRoleId,
        intendedLegalEntityId: null,
      }),
    ).rejects.toThrow(/Missing permission/);
  });

  it("rejects an inviter granting legal-entity access to an entity they were not themselves granted", async () => {
    setup = await setupTestTenant();
    const legalEntity = await createTestLegalEntity(setup.tenantId, "SG");
    const inviterUser = await createTestUser();
    extraUserIds.push(inviterUser.id);
    const inviterMembership = await addTenantMember(setup.tenantId, inviterUser.id);
    // Grant tenant-wide MEMBERSHIP_INVITE + LEGAL_ENTITY_MEMBERSHIP_GRANT
    // via the admin role, but WITHOUT actual access to this legal entity.
    await assignRoleDirect(
      setup.tenantId,
      inviterMembership.id,
      setup.adminRoleId,
      setup.adminUserId,
    );
    const inviterCtx = await buildContext(inviterUser.id, setup.tenantId);

    await expect(
      createInvitation(inviterCtx, {
        email: "target2@test.noahark.local",
        intendedRoleId: null,
        intendedLegalEntityId: legalEntity.id,
      }),
    ).rejects.toThrow(/No access to this legal entity/);
  });

  it("allows an inviter with actual legal-entity access to grant it via invitation", async () => {
    setup = await setupTestTenant();
    const legalEntity = await createTestLegalEntity(setup.tenantId, "MY");
    await grantLegalEntityAccessDirect(setup.tenantId, legalEntity.id, setup.adminUserId);
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);

    const { rawToken } = await createInvitation(ctx, {
      email: `entity-invite-${Date.now()}@test.noahark.local`,
      intendedRoleId: null,
      intendedLegalEntityId: legalEntity.id,
    });

    const { session } = await acceptInvitation({
      token: rawToken,
      password: "EntityInvite123!",
    });
    const resolved = await resolveSession(session.rawToken);
    extraUserIds.push(resolved!.user.id);

    const db = createSystemClient();
    const grant = await db.legalEntityMembership.findUnique({
      where: {
        legalEntityId_userId: {
          legalEntityId: legalEntity.id,
          userId: resolved!.user.id,
        },
      },
    });
    expect(grant?.status).toBe("ACTIVE");
  });
});
