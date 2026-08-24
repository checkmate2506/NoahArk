"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Label } from "@noahark/ui";

export function AssignRoleForm({
  tenantId,
  tenantMembershipId,
  roles,
  legalEntities,
}: {
  tenantId: string;
  tenantMembershipId: string;
  roles: { id: string; name: string }[];
  legalEntities: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [roleId, setRoleId] = useState(roles[0]?.id ?? "");
  const [legalEntityId, setLegalEntityId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!roleId) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/tenants/${tenantId}/role-assignments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantMembershipId,
          roleId,
          legalEntityId: legalEntityId || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? "Failed to assign role");
        return;
      }
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  if (roles.length === 0) return null;

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2" noValidate>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`role-${tenantMembershipId}`} className="text-xs">
          Role
        </Label>
        <select
          id={`role-${tenantMembershipId}`}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          value={roleId}
          onChange={(e) => setRoleId(e.target.value)}
        >
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`scope-${tenantMembershipId}`} className="text-xs">
          Scope
        </Label>
        <select
          id={`scope-${tenantMembershipId}`}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          value={legalEntityId}
          onChange={(e) => setLegalEntityId(e.target.value)}
        >
          <option value="">Tenant-wide</option>
          {legalEntities.map((le) => (
            <option key={le.id} value={le.id}>
              {le.name}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" size="sm" disabled={submitting}>
        {submitting ? "Assigning..." : "Assign"}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
