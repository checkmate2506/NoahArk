import { describe, expect, it } from "vitest";
import type { AccessContext } from "@noahark/core";
import {
  decide,
  assertApprovalAuthority,
  validateStepSequence,
  type ApprovalRequestState,
  type ApprovalStepDef,
} from "./approvalEngine";

const ONE_STEP: ApprovalStepDef[] = [{ stepOrder: 1, approverRoleId: "role-approver" }];
const TWO_STEPS: ApprovalStepDef[] = [
  { stepOrder: 1, approverRoleId: "role-approver-1" },
  { stepOrder: 2, approverRoleId: "role-approver-2" },
];

function pending(overrides: Partial<ApprovalRequestState> = {}): ApprovalRequestState {
  return { status: "PENDING", currentStepOrder: 1, version: 1, ...overrides };
}

describe("decide — single-step policy", () => {
  it("APPROVE on the last step moves the request to APPROVED (terminal)", () => {
    const result = decide(pending(), {
      action: "APPROVE",
      actorUserId: "approver-1",
      submittedByUserId: "submitter-1",
      expectedVersion: 1,
      steps: ONE_STEP,
      existingDecisionForCurrentStep: false,
    });
    expect(result.nextStatus).toBe("APPROVED");
    expect(result.isTerminal).toBe(true);
    expect(result.nextVersion).toBe(2);
  });

  it("REJECT moves the request to REJECTED (terminal) from any step", () => {
    const result = decide(pending(), {
      action: "REJECT",
      actorUserId: "approver-1",
      submittedByUserId: "submitter-1",
      expectedVersion: 1,
      steps: ONE_STEP,
      existingDecisionForCurrentStep: false,
    });
    expect(result.nextStatus).toBe("REJECTED");
    expect(result.isTerminal).toBe(true);
  });
});

describe("decide — multi-step policy", () => {
  it("APPROVE on a non-final step advances to the next step and stays PENDING", () => {
    const result = decide(pending({ currentStepOrder: 1 }), {
      action: "APPROVE",
      actorUserId: "approver-1",
      submittedByUserId: "submitter-1",
      expectedVersion: 1,
      steps: TWO_STEPS,
      existingDecisionForCurrentStep: false,
    });
    expect(result.nextStatus).toBe("PENDING");
    expect(result.nextStepOrder).toBe(2);
    expect(result.isTerminal).toBe(false);
  });

  it("APPROVE on the final step of a multi-step policy terminates as APPROVED", () => {
    const result = decide(pending({ currentStepOrder: 2 }), {
      action: "APPROVE",
      actorUserId: "approver-2",
      submittedByUserId: "submitter-1",
      expectedVersion: 1,
      steps: TWO_STEPS,
      existingDecisionForCurrentStep: false,
    });
    expect(result.nextStatus).toBe("APPROVED");
    expect(result.isTerminal).toBe(true);
  });
});

describe("decide — cancellation", () => {
  it("allows the submitter to cancel a pending request", () => {
    const result = decide(pending(), {
      action: "CANCEL",
      actorUserId: "submitter-1",
      submittedByUserId: "submitter-1",
      expectedVersion: 1,
      steps: ONE_STEP,
      existingDecisionForCurrentStep: false,
    });
    expect(result.nextStatus).toBe("CANCELLED");
  });

  it("rejects cancellation by anyone other than the submitter", () => {
    expect(() =>
      decide(pending(), {
        action: "CANCEL",
        actorUserId: "someone-else",
        submittedByUserId: "submitter-1",
        expectedVersion: 1,
        steps: ONE_STEP,
        existingDecisionForCurrentStep: false,
      }),
    ).toThrow(/Only the submitter/);
  });
});

describe("decide — terminal-state and concurrency guards", () => {
  it("rejects a decision on a request that is already terminal", () => {
    expect(() =>
      decide(pending({ status: "APPROVED" }), {
        action: "APPROVE",
        actorUserId: "approver-1",
        submittedByUserId: "submitter-1",
        expectedVersion: 1,
        steps: ONE_STEP,
        existingDecisionForCurrentStep: false,
      }),
    ).toThrow(/already approved/);
  });

  it("rejects a stale version (optimistic concurrency)", () => {
    expect(() =>
      decide(pending({ version: 5 }), {
        action: "APPROVE",
        actorUserId: "approver-1",
        submittedByUserId: "submitter-1",
        expectedVersion: 1,
        steps: ONE_STEP,
        existingDecisionForCurrentStep: false,
      }),
    ).toThrow(/modified by someone else/);
  });

  it("rejects a duplicate decision for the same step", () => {
    expect(() =>
      decide(pending(), {
        action: "APPROVE",
        actorUserId: "approver-1",
        submittedByUserId: "submitter-1",
        expectedVersion: 1,
        steps: ONE_STEP,
        existingDecisionForCurrentStep: true,
      }),
    ).toThrow(/already been decided/);
  });
});

describe("assertApprovalAuthority", () => {
  function ctx(overrides: Partial<AccessContext> = {}): AccessContext {
    return {
      requestId: "r1",
      userId: "u1",
      tenantId: "t1",
      legalEntityIds: new Set(),
      permissions: new Set(),
      legalEntityPermissions: new Map(),
      roleIds: new Set(),
      legalEntityRoleIds: new Map(),
      ...overrides,
    };
  }

  const notSelf = { submittedByUserId: "someone-else", allowSelfApproval: false };

  it("rejects a decision from a user who does not hold the approver role", () => {
    expect(() => assertApprovalAuthority(ctx(), ONE_STEP[0]!, null, notSelf)).toThrow(
      /do not hold the role/,
    );
  });

  it("allows a decision from a user who holds the tenant-wide approver role", () => {
    const c = ctx({ roleIds: new Set(["role-approver"]) });
    expect(() => assertApprovalAuthority(c, ONE_STEP[0]!, null, notSelf)).not.toThrow();
  });

  it("allows a decision from a user who holds the role scoped to the relevant legal entity", () => {
    const c = ctx({
      legalEntityIds: new Set(["le-sg"]),
      legalEntityRoleIds: new Map([["le-sg", new Set(["role-approver"])]]),
    });
    expect(() =>
      assertApprovalAuthority(c, ONE_STEP[0]!, "le-sg", notSelf),
    ).not.toThrow();
  });

  it("does not let a role scoped to one legal entity authorize a decision in another", () => {
    const c = ctx({
      legalEntityIds: new Set(["le-sg", "le-my"]),
      legalEntityRoleIds: new Map([["le-sg", new Set(["role-approver"])]]),
    });
    expect(() => assertApprovalAuthority(c, ONE_STEP[0]!, "le-my", notSelf)).toThrow(
      /do not hold the role/,
    );
  });

  describe("self-approval (F-18)", () => {
    it("rejects a submitter who holds the approver role from deciding their own request by default", () => {
      const c = ctx({ userId: "submitter-1", roleIds: new Set(["role-approver"]) });
      expect(() =>
        assertApprovalAuthority(c, ONE_STEP[0]!, null, {
          submittedByUserId: "submitter-1",
          allowSelfApproval: false,
        }),
      ).toThrow(/cannot approve or reject your own request/);
    });

    it("allows self-approval only when the policy explicitly opts in", () => {
      const c = ctx({ userId: "submitter-1", roleIds: new Set(["role-approver"]) });
      expect(() =>
        assertApprovalAuthority(c, ONE_STEP[0]!, null, {
          submittedByUserId: "submitter-1",
          allowSelfApproval: true,
        }),
      ).not.toThrow();
    });

    it("does not affect a decision by someone other than the submitter", () => {
      const c = ctx({ userId: "approver-1", roleIds: new Set(["role-approver"]) });
      expect(() =>
        assertApprovalAuthority(c, ONE_STEP[0]!, null, {
          submittedByUserId: "submitter-1",
          allowSelfApproval: false,
        }),
      ).not.toThrow();
    });
  });
});

describe("validateStepSequence", () => {
  it("rejects an empty step list", () => {
    expect(() => validateStepSequence([])).toThrow(/at least one step/);
  });

  it("rejects a gapped step sequence", () => {
    expect(() =>
      validateStepSequence([
        { stepOrder: 1, approverRoleId: "r1" },
        { stepOrder: 3, approverRoleId: "r2" },
      ]),
    ).toThrow(/gapless sequence/);
  });

  it("accepts a valid gapless sequence", () => {
    expect(() => validateStepSequence(TWO_STEPS)).not.toThrow();
  });
});
