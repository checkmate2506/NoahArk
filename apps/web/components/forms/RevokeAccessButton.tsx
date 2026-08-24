"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@noahark/ui";

export function RevokeAccessButton({
  tenantId,
  legalEntityId,
  userId,
}: {
  tenantId: string;
  legalEntityId: string;
  userId: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    try {
      await fetch(
        `/api/v1/tenants/${tenantId}/legal-entities/${legalEntityId}/access/${userId}`,
        {
          method: "DELETE",
        },
      );
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
