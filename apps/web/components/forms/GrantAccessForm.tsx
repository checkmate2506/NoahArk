"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Label } from "@noahark/ui";

interface MembershipOption {
  id: string;
  userId: string;
  label: string;
}

export function GrantAccessForm({
  tenantId,
  legalEntityId,
  candidates,
}: {
  tenantId: string;
  legalEntityId: string;
  candidates: MembershipOption[];
}) {
  const router = useRouter();
  const [userId, setUserId] = useState(candidates[0]?.userId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!userId) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/tenants/${tenantId}/legal-entities/${legalEntityId}/access`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? "Failed to grant access");
        return;
      }
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  if (candidates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No other members available to grant access to.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="grant-user">Member</Label>
        <select
          id="grant-user"
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        >
          {candidates.map((c) => (
            <option key={c.id} value={c.userId}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" disabled={submitting}>
        {submitting ? "Granting..." : "Grant access"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
