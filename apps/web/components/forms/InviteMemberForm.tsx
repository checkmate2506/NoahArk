"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label } from "@noahark/ui";

export function InviteMemberForm({
  tenantId,
  roles,
  legalEntities,
}: {
  tenantId: string;
  roles: { id: string; name: string }[];
  legalEntities: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("");
  const [legalEntityId, setLegalEntityId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setAcceptUrl(null);
    try {
      const res = await fetch(`/api/v1/tenants/${tenantId}/invitations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          intendedRoleId: roleId || null,
          intendedLegalEntityId: legalEntityId || null,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "Failed to create invitation");
        return;
      }
      // Phase 1 has no production email provider (AD-3) — the console log
      // is the delivery mechanism, and the accept link is also surfaced
      // here once so an admin can hand it to the invitee directly.
      setAcceptUrl(
        `${window.location.origin}/invitations/accept?token=${body.data.rawToken}`,
      );
      setEmail("");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3 rounded-md border border-input p-4"
      noValidate
    >
      <p className="text-sm font-medium">Invite a member</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="invite-email" className="text-xs">
            Email
          </Label>
          <Input
            id="invite-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="invite-role" className="text-xs">
            Role
          </Label>
          <select
            id="invite-role"
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
          >
            <option value="">No role yet</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="invite-entity" className="text-xs">
            Legal entity access
          </Label>
          <select
            id="invite-entity"
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={legalEntityId}
            onChange={(e) => setLegalEntityId(e.target.value)}
          >
            <option value="">None</option>
            {legalEntities.map((le) => (
              <option key={le.id} value={le.id}>
                {le.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting ? "Sending..." : "Send invite"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {acceptUrl && (
        <p className="text-xs text-muted-foreground">
          Invitation created. Accept link (dev — no email provider configured):{" "}
          <code className="break-all">{acceptUrl}</code>
        </p>
      )}
    </form>
  );
}
