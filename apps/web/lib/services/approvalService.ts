import { z } from "zod";
import { authorize, PERMISSIONS } from "@noahark/authz";
import {
  type AccessContext,
  NotFoundError,
  ConflictError,
  StaleVersionError,
  omitUndefined,
} from "@noahark/core";
import { withTenantContext } from "@noahark/db";
import { decide, assertApprovalAuthority, validateStepSequence } from "@noahark/workflow";
import { AUDIT_ACTIONS } from "@noahark/audit";
import { writeAuditEvent } from "./auditService";
import { assertModuleEnabledTx, MODULE_KEYS } from "./entitlementService";

export async function listApprovalRequests(ctx: AccessContext) {
  authorize(ctx, { permission: PERMISSIONS.APPROVAL_READ });
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds },
    (tx) =>
      tx.approvalRequest.findMany({
        where: { tenantId: ctx.tenantId },
        include: { decisions: true, approvalPolicy: { include: { steps: true } } },
        orderBy: { submittedAt: "desc" },
      }),
  );
}

export const CreateDemoApprovalSubjectSchema = z.object({
  title: z.string().min(1).max(200),
  legalEntityId: z.string().min(1).nullable().default(null),
});

/** Creates the neutral demo resource AND immediately submits it for
 * approval against the tenant's active `demo.approval_subject` policy —
 * the end-to-end proof of the approval engine required by PHASE_01_FOUNDATION
 * §14, deliberately not an invoice/payroll/expense workflow. */
export async function createAndSubmitDemoSubject(
  ctx: AccessContext,
  input: z.infer<typeof CreateDemoApprovalSubjectSchema>,
) {
  authorize(ctx, {
    permission: PERMISSIONS.APPROVAL_SUBMIT,
    legalEntityId: input.legalEntityId,
  });

  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      // F-17 (Phase 1B): checked in the SAME transaction as the write below.
      await assertModuleEnabledTx(tx, ctx.tenantId, MODULE_KEYS.APPROVALS);

      const subject = await tx.demoApprovalSubject.create({
        data: {
          tenantId: ctx.tenantId,
          legalEntityId: input.legalEntityId,
          title: input.title,
          createdByUserId: ctx.userId,
        },
      });

      const policy = await tx.approvalPolicy.findFirst({
        where: {
          tenantId: ctx.tenantId,
          subjectType: "demo.approval_subject",
          isActive: true,
        },
        include: { steps: true },
      });
      if (!policy) {
        throw new ConflictError("No active approval policy for demo.approval_subject");
      }
      validateStepSequence(
        policy.steps.map((s) => ({
          stepOrder: s.stepOrder,
          approverRoleId: s.approverRoleId,
        })),
      );

      const request = await tx.approvalRequest.create({
        data: {
          tenantId: ctx.tenantId,
          legalEntityId: input.legalEntityId,
          approvalPolicyId: policy.id,
          subjectType: "demo.approval_subject",
          subjectId: subject.id,
          submittedByUserId: ctx.userId,
        },
      });

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        legalEntityId: input.legalEntityId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.APPROVAL_SUBMITTED,
        entityType: "approval_request",
        entityId: request.id,
        afterData: request,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });

      return { subject, request };
    },
  );
}

export const DecideApprovalSchema = z.object({
  action: z.enum(["APPROVE", "REJECT", "CANCEL"]),
  comment: z.string().max(1000).optional(),
  expectedVersion: z.number().int().positive(),
});

export async function decideApproval(
  ctx: AccessContext,
  requestId: string,
  input: z.infer<typeof DecideApprovalSchema>,
) {
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      // F-17 (Phase 1B): checked in THIS transaction, not a separate one —
      // closes a TOCTOU window where a module could be disabled by another
      // request between the check and this decision's own write.
      await assertModuleEnabledTx(tx, ctx.tenantId, MODULE_KEYS.APPROVALS);

      const request = await tx.approvalRequest.findUnique({
        where: { id: requestId },
        include: { approvalPolicy: { include: { steps: true } }, decisions: true },
      });
      if (!request || request.tenantId !== ctx.tenantId) {
        throw new NotFoundError("Approval request");
      }

      // Check 3 (module permission) — additive to, not a substitute for,
      // check 6 (approval authority) below. F-18 (Phase 1B): skipped for
      // CANCEL — `approval:decide` represents authority to decide on
      // OTHER people's requests; withdrawing your OWN pending request is a
      // narrower, distinct action authorized solely by decide()'s "only
      // the submitter may cancel" rule below. Requiring `approval:decide`
      // here would wrongly block a plain submitter (e.g. the `member`
      // system role, which holds APPROVAL_SUBMIT but not APPROVAL_DECIDE)
      // from ever cancelling their own request.
      if (input.action !== "CANCEL") {
        authorize(ctx, {
          permission: PERMISSIONS.APPROVAL_DECIDE,
          legalEntityId: request.legalEntityId,
        });
      }

      const steps = request.approvalPolicy.steps.map((s) => ({
        stepOrder: s.stepOrder,
        approverRoleId: s.approverRoleId,
      }));
      const currentStep = steps.find((s) => s.stepOrder === request.currentStepOrder);
      if (!currentStep)
        throw new ConflictError("No approval step defined for the current order");

      // F-18 (Phase 1B): Check 6 (approval authority — the actor must hold
      // the SPECIFIC role this step names, and self-approval is
      // policy-gated) applies ONLY to APPROVE/REJECT. CANCEL has its own
      // authority rule enforced inside decide() below (only the
      // submitter) — gating it on approver-role membership here would
      // wrongly block a submitter without that role from cancelling their
      // own pending request.
      if (input.action !== "CANCEL") {
        try {
          assertApprovalAuthority(ctx, currentStep, request.legalEntityId, {
            submittedByUserId: request.submittedByUserId,
            allowSelfApproval: request.approvalPolicy.allowSelfApproval,
          });
        } catch (e) {
          await writeAuditEvent(tx, {
            tenantId: ctx.tenantId,
            legalEntityId: request.legalEntityId,
            actorUserId: ctx.userId,
            action: AUDIT_ACTIONS.AUTHORIZATION_DENIED,
            entityType: "approval_request",
            entityId: requestId,
            afterData: {
              attemptedAction: input.action,
              isSelfApproval: ctx.userId === request.submittedByUserId,
            },
            outcome: "DENIED",
            requestId: ctx.requestId,
            ipAddress: ctx.ipAddress,
            userAgent: ctx.userAgent,
          });
          throw e;
        }
      }

      const existingDecisionForCurrentStep = request.decisions.some(
        (d) => d.stepOrder === request.currentStepOrder,
      );

      const result = decide(
        {
          status: request.status,
          currentStepOrder: request.currentStepOrder,
          version: request.version,
        },
        {
          action: input.action,
          actorUserId: ctx.userId,
          submittedByUserId: request.submittedByUserId,
          expectedVersion: input.expectedVersion,
          steps,
          existingDecisionForCurrentStep,
        },
      );

      // Belt-and-braces DB-level optimistic-concurrency guard: even though
      // decide() already checked the version in memory, a concurrent
      // transaction could have committed between our read and this write.
      const updateResult = await tx.approvalRequest.updateMany({
        where: { id: requestId, version: request.version },
        data: {
          status: result.nextStatus,
          currentStepOrder: result.nextStepOrder,
          version: result.nextVersion,
          ...(result.isTerminal ? { decidedAt: new Date() } : {}),
        },
      });
      if (updateResult.count === 0) throw new StaleVersionError("ApprovalRequest");

      const decision = await tx.approvalDecision.create({
        data: {
          tenantId: ctx.tenantId,
          approvalRequestId: requestId,
          stepOrder: request.currentStepOrder,
          action: input.action,
          actorUserId: ctx.userId,
          ...omitUndefined({ comment: input.comment }),
        },
      });

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        legalEntityId: request.legalEntityId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.APPROVAL_DECIDED,
        entityType: "approval_request",
        entityId: requestId,
        afterData: {
          status: result.nextStatus,
          currentStepOrder: result.nextStepOrder,
          decisionAction: input.action,
        },
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });

      return {
        status: result.nextStatus,
        currentStepOrder: result.nextStepOrder,
        version: result.nextVersion,
        decision,
      };
    },
  );
}
