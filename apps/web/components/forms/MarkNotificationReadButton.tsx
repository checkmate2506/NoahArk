"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@noahark/ui";

export function MarkNotificationReadButton({
  tenantId,
  notificationId,
}: {
  tenantId: string;
  notificationId: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    try {
      await fetch(`/api/v1/tenants/${tenantId}/notifications/${notificationId}/read`, {
        method: "POST",
      });
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <Button size="sm" variant="ghost" onClick={onClick} disabled={pending}>
      {pending ? "..." : "Mark read"}
    </Button>
  );
}
