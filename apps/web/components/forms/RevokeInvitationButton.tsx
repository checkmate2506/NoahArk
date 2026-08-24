"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@noahark/ui";

export function RevokeInvitationButton({
  tenantId,
  invitationId,
}: {
  tenantId: string;
  invitationId: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    try {
      await fetch(`/api/v1/tenants/${tenantId}/invitations/${invitationId}`, {
        method: "DELETE",
      });
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={onClick} disabled={pending}>
      {pending ? "Revoking..." : "Revoke"}
    </Button>
  );
}
