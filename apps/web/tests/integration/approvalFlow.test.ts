import { afterEach, describe, expect, it } from "vitest";
import { createSystemClient } from "@noahark/db/system";
import {
  createAndSubmitDemoSubject,
  decideApproval,
  listApprovalRequests,
} from "@/lib/services/approvalService";
import {
  setupTestTenant,
  buildContext,
  cleanupTenant,
  cleanupUser,
  createTestUser,
  addTenantMember,
  assignRoleDirect,
  type TestTenantSetup,
} from "./testHelpers";

describe("approval engine (real Postgres)", () => {
  let setup: TestTenantSetup;
  let extraUserIds: string[] = [];

  afterEach(async () => {
    if (setup) {
      await cleanupTenant(setup.tenantId);
      for (const id of extraUserIds) await cleanupUser(id);
      await cleanupUser(setup.adminUserId);
      extraUserIds = [];
    }
  });

  // allowSelfApproval defaults to true here: these tests use the SAME user
  // to submit and decide, deliberately, to isolate the state-machine
  // mechanics (duplicate decision, stale version, terminal state) from the
  // F-18 self-approval POLICY, which has its own dedicated test below.
  async function seedPolicy(approverRoleId: string, allowSelfApproval = true) {
    const db = createSystemClient();
    const policy = await db.approvalPolicy.create({
      data: {
        tenantId: setup.tenantId,
        subjectType: "demo.approval_subject",
        name: "Test policy",
        isActive: true,
        allowSelfApproval,
      },
    });
    await db.approvalStep.create({
      data: {
        tenantId: setup.tenantId,
        approvalPolicyId: policy.id,
        stepOrder: 1,
        approverRoleId,
      },
    });
    return policy;
  }

  it("submits and approves a single-step demo request end to end", async () => {
    setup = await setupTestTenant();
    await seedPolicy(setup.adminRoleId);
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);

    const { request } = await createAndSubmitDemoSubject(ctx, {
      title: "Test request",
      legalEntityId: null,
    });
    expect(request.status).toBe("PENDING");

    const result = await decideApproval(ctx, request.id, {
      action: "APPROVE",
      expectedVersion: request.version,
    });
    expect(result.status).toBe("APPROVED");

    const { requests } = await listApprovalRequests(ctx).then((requests) => ({
      requests,
    }));
    expect(requests.find((r) => r.id === request.id)?.status).toBe("APPROVED");
  });

  it("rejects a decision from a user who does not hold the approver role", async () => {
    setup = await setupTestTenant();
    await seedPolicy(setup.adminRoleId); // only tenant_admin can approve

    const otherUser = await createTestUser();
    extraUserIds.push(otherUser.id);
    const otherMembership = await addTenantMember(setup.tenantId, otherUser.id);
    // give otherUser only the member role, which is not the approver role
    await assignRoleDirect(
      setup.tenantId,
      otherMembership.id,
      setup.memberRoleId,
      setup.adminUserId,
    );

    const adminCtx = await buildContext(setup.adminUserId, setup.tenantId);
    const { request } = await createAndSubmitDemoSubject(adminCtx, {
      title: "Needs admin",
      legalEntityId: null,
    });

    const otherCtx = await buildContext(otherUser.id, setup.tenantId);
    await expect(
      decideApproval(otherCtx, request.id, {
        action: "APPROVE",
        expectedVersion: request.version,
      }),
    ).rejects.toThrow(/do not hold the role|Missing permission/);
  });

  it("rejects a duplicate decision on the same step", async () => {
    setup = await setupTestTenant();
    await seedPolicy(setup.adminRoleId);
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);

    const { request } = await createAndSubmitDemoSubject(ctx, {
      title: "Dup test",
      legalEntityId: null,
    });
    await decideApproval(ctx, request.id, {
      action: "APPROVE",
      expectedVersion: request.version,
    });

    // Re-fetch to get the post-approval version, then attempt ANOTHER
    // decision on what is now a terminal (already-decided) request.
    const { requests } = await listApprovalRequests(ctx).then((r) => ({ requests: r }));
    const after = requests.find((r) => r.id === request.id)!;

    await expect(
      decideApproval(ctx, request.id, {
        action: "APPROVE",
        expectedVersion: after.version,
      }),
    ).rejects.toThrow(/already approved/);
  });

  it("rejects a decision with a stale expectedVersion (optimistic concurrency)", async () => {
    setup = await setupTestTenant();
    await seedPolicy(setup.adminRoleId);
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);

    const { request } = await createAndSubmitDemoSubject(ctx, {
      title: "Stale test",
      legalEntityId: null,
    });

    await expect(
      decideApproval(ctx, request.id, {
        action: "APPROVE",
        expectedVersion: request.version + 99,
      }),
    ).rejects.toThrow(/modified by someone else/);
  });

  describe("F-18 — self-approval and cancellation authority", () => {
    it("rejects a submitter who holds the approver role from approving their own request by default", async () => {
      setup = await setupTestTenant();
      await seedPolicy(setup.adminRoleId, false); // allowSelfApproval: false
      const ctx = await buildContext(setup.adminUserId, setup.tenantId);

      const { request } = await createAndSubmitDemoSubject(ctx, {
        title: "Self-approval test",
        legalEntityId: null,
      });

      await expect(
        decideApproval(ctx, request.id, {
          action: "APPROVE",
          expectedVersion: request.version,
        }),
      ).rejects.toThrow(/cannot approve or reject your own request/);
    });

    it("allows self-approval only when the policy explicitly opts in", async () => {
      setup = await setupTestTenant();
      await seedPolicy(setup.adminRoleId, true);
      const ctx = await buildContext(setup.adminUserId, setup.tenantId);

      const { request } = await createAndSubmitDemoSubject(ctx, {
        title: "Self-approval allowed",
        legalEntityId: null,
      });

      const result = await decideApproval(ctx, request.id, {
        action: "APPROVE",
        expectedVersion: request.version,
      });
      expect(result.status).toBe("APPROVED");
    });

    it("lets a submitter without the approver role cancel their own pending request", async () => {
      setup = await setupTestTenant();
      await seedPolicy(setup.adminRoleId, false); // submitter (member) does NOT hold this role

      const memberUser = await createTestUser();
      extraUserIds.push(memberUser.id);
      const membership = await addTenantMember(setup.tenantId, memberUser.id);
      await assignRoleDirect(
        setup.tenantId,
        membership.id,
        setup.memberRoleId,
        setup.adminUserId,
      );

      const memberCtx = await buildContext(memberUser.id, setup.tenantId);
      const { request } = await createAndSubmitDemoSubject(memberCtx, {
        title: "Cancel without approver role",
        legalEntityId: null,
      });

      const result = await decideApproval(memberCtx, request.id, {
        action: "CANCEL",
        expectedVersion: request.version,
      });
      expect(result.status).toBe("CANCELLED");
    });
  });
});
