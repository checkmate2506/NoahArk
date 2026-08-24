import { resolveTenantContextForPage } from "@/lib/context";
import { listApprovalRequests } from "@/lib/services/approvalService";
import { can, PERMISSIONS } from "@noahark/authz";
import { hasRole } from "@noahark/core";
import { Card, CardContent, Badge, EmptyState } from "@noahark/ui";
import { SubmitDemoApprovalForm } from "@/components/forms/SubmitDemoApprovalForm";
import { DecideApprovalButtons } from "@/components/forms/DecideApprovalButtons";

const STATUS_VARIANT = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  CANCELLED: "neutral",
} as const;

export default async function ApprovalsPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  const ctx = await resolveTenantContextForPage(tenantId);
  const requests = await listApprovalRequests(ctx);
  const canSubmit = can(ctx, { permission: PERMISSIONS.APPROVAL_SUBMIT });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Approvals</h1>
      <p className="text-sm text-muted-foreground">
        A neutral demonstration workflow proving the approval engine end to end — not a
        business document approval.
      </p>

      {canSubmit && <SubmitDemoApprovalForm tenantId={tenantId} />}

      {requests.length === 0 ? (
        <EmptyState title="No approval requests yet" />
      ) : (
        <div className="flex flex-col gap-2">
          {requests.map((request) => {
            const currentStep = request.approvalPolicy.steps.find(
              (s) => s.stepOrder === request.currentStepOrder,
            );
            const canDecide =
              request.status === "PENDING" &&
              currentStep &&
              can(ctx, {
                permission: PERMISSIONS.APPROVAL_DECIDE,
                legalEntityId: request.legalEntityId,
              }) &&
              hasRole(ctx, currentStep.approverRoleId, request.legalEntityId);
            const canCancel =
              request.status === "PENDING" && request.submittedByUserId === ctx.userId;

            return (
              <Card key={request.id} data-testid={`approval-request-${request.id}`}>
                <CardContent className="flex flex-col gap-2 p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">
                      {request.subjectType} · step {request.currentStepOrder}
                    </p>
                    <Badge variant={STATUS_VARIANT[request.status]}>
                      {request.status}
                    </Badge>
                  </div>
                  {(canDecide || canCancel) && (
                    <DecideApprovalButtons
                      tenantId={tenantId}
                      requestId={request.id}
                      version={request.version}
                      showCancel={canCancel}
                    />
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
