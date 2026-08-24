import {
  type AccessContext,
  hasRole,
  ConflictError,
  ForbiddenError,
  StaleVersionError,
} from "@noahark/core";

export type ApprovalRequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
export type ApprovalDecisionAction = "APPROVE" | "REJECT" | "CANCEL";

export interface ApprovalStepDef {
  stepOrder: number;
  approverRoleId: string;
}

export interface ApprovalRequestState {
  status: ApprovalRequestStatus;
  currentStepOrder: number;
  version: number;
}

export interface DecideInput {
  action: ApprovalDecisionAction;
  actorUserId: string;
  submittedByUserId: string;
  /** Optimistic-concurrency token the caller read the request at. */
  expectedVersion: number;
  /** All steps for the request's policy, any order. */
  steps: readonly ApprovalStepDef[];
  /** Whether a decision row already exists for the current step — the
   * caller checks this against the DB's unique(approvalRequestId, stepOrder)
   * constraint before calling, giving defense in depth against duplicates
   * (the constraint itself is the final backstop). */
  existingDecisionForCurrentStep: boolean;
}

export interface DecideResult {
  nextStatus: ApprovalRequestStatus;
  nextStepOrder: number;
  nextVersion: number;
  /** true when this decision moves the request into a terminal state
   * (APPROVED / REJECTED / CANCELLED) — callers should stamp decidedAt. */
  isTerminal: boolean;
}

/**
 * Pure state-transition function — no I/O, fully unit-testable. The caller
 * (a service with DB access) is responsible for: loading state + steps,
 * checking `existingDecisionForCurrentStep`, calling `assertApprovalAuthority`
 * separately, persisting the result inside a transaction guarded by
 * `WHERE version = expectedVersion`, and recording the ApprovalDecision row.
 */
export function decide(state: ApprovalRequestState, input: DecideInput): DecideResult {
  if (state.status !== "PENDING") {
    throw new ConflictError(`Approval request is already ${state.status.toLowerCase()}`);
  }
  if (state.version !== input.expectedVersion) {
    throw new StaleVersionError("ApprovalRequest");
  }
  if (input.existingDecisionForCurrentStep) {
    throw new ConflictError("This approval step has already been decided");
  }

  const step = input.steps.find((s) => s.stepOrder === state.currentStepOrder);
  if (!step) {
    throw new ConflictError(
      `No approval step defined for order ${state.currentStepOrder}`,
    );
  }

  const nextVersion = state.version + 1;

  if (input.action === "CANCEL") {
    if (input.actorUserId !== input.submittedByUserId) {
      throw new ForbiddenError(
        "Only the submitter may cancel a pending approval request",
      );
    }
    return {
      nextStatus: "CANCELLED",
      nextStepOrder: state.currentStepOrder,
      nextVersion,
      isTerminal: true,
    };
  }

  if (input.action === "REJECT") {
    return {
      nextStatus: "REJECTED",
      nextStepOrder: state.currentStepOrder,
      nextVersion,
      isTerminal: true,
    };
  }

  // APPROVE
  const maxStepOrder = Math.max(...input.steps.map((s) => s.stepOrder));
  if (state.currentStepOrder < maxStepOrder) {
    return {
      nextStatus: "PENDING",
      nextStepOrder: state.currentStepOrder + 1,
      nextVersion,
      isTerminal: false,
    };
  }
  return {
    nextStatus: "APPROVED",
    nextStepOrder: state.currentStepOrder,
    nextVersion,
    isTerminal: true,
  };
}

/**
 * Approval authority (the 6th independent security check —
 * SECURITY_AND_TENANCY.md §3). Distinct from a permission check: the actor
 * must hold the *specific role* the current step names as its approver,
 * not merely an `approval:decide` permission.
 *
 * F-18 (Phase 1B): APPROVE/REJECT only — CANCEL has its own authority rule
 * (only the submitter, checked inside `decide()`) and must NOT be gated by
 * step-approver-role membership. The service layer previously called this
 * unconditionally before `decide()`, which meant a submitter who did not
 * happen to hold the approver role could never cancel their own pending
 * request — contradicting `decide()`'s own "only the submitter may cancel"
 * rule. Callers must skip this check entirely for `action === "CANCEL"`.
 *
 * Also enforces default-denied self-approval: a submitter who DOES hold the
 * approver role cannot approve/reject their own request unless the
 * policy's `allowSelfApproval` is explicitly true — segregation of duties
 * by default.
 */
export function assertApprovalAuthority(
  ctx: AccessContext,
  step: ApprovalStepDef,
  legalEntityId: string | null,
  input: { submittedByUserId: string; allowSelfApproval: boolean },
): void {
  if (!hasRole(ctx, step.approverRoleId, legalEntityId)) {
    throw new ForbiddenError(
      "You do not hold the role required to decide this approval step",
    );
  }
  if (ctx.userId === input.submittedByUserId && !input.allowSelfApproval) {
    throw new ForbiddenError(
      "You cannot approve or reject your own request — this policy does not allow self-approval",
    );
  }
}

/** Validates a policy has at least one step and step orders are a gapless
 * sequence starting at 1 — called when an ApprovalPolicy is activated. */
export function validateStepSequence(steps: readonly ApprovalStepDef[]): void {
  if (steps.length === 0) {
    throw new ConflictError("An approval policy must have at least one step");
  }
  const orders = [...steps.map((s) => s.stepOrder)].sort((a, b) => a - b);
  for (let i = 0; i < orders.length; i++) {
    if (orders[i] !== i + 1) {
      throw new ConflictError(
        "Approval step order must be a gapless sequence starting at 1",
      );
    }
  }
}
