"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@noahark/ui";

export function DecideApprovalButtons({
  tenantId,
  requestId,
  version,
  showCancel,
}: {
  tenantId: string;
  requestId: string;
  version: number;
  showCancel: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(action: "APPROVE" | "REJECT" | "CANCEL") {
    setPending(action);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/tenants/${tenantId}/approvals/${requestId}/decide`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, expectedVersion: version }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? "Failed to record decision");
        return;
      }
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" onClick={() => decide("APPROVE")} disabled={pending !== null}>
        {pending === "APPROVE" ? "..." : "Approve"}
      </Button>
      <Button
        size="sm"
        variant="destructive"
        onClick={() => decide("REJECT")}
        disabled={pending !== null}
      >
        {pending === "REJECT" ? "..." : "Reject"}
      </Button>
      {showCancel && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => decide("CANCEL")}
          disabled={pending !== null}
        >
          {pending === "CANCEL" ? "..." : "Cancel"}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
