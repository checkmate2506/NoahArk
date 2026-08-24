"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Input,
  Label,
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@noahark/ui";

export function CreateRoleForm({
  tenantId,
  availablePermissions,
}: {
  tenantId: string;
  availablePermissions: string[];
}) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function toggle(permission: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return next;
    });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/tenants/${tenantId}/roles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, name, permissionKeys: [...selected] }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? "Failed to create role");
        return;
      }
      setKey("");
      setName("");
      setSelected(new Set());
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Create role</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="role-key">Key</Label>
              <Input
                id="role-key"
                placeholder="e.g. finance_viewer"
                required
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="role-name">Name</Label>
              <Input
                id="role-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">
              Permissions{" "}
              <span className="font-normal text-muted-foreground">
                (only permissions you hold yourself can be granted)
              </span>
            </p>
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {availablePermissions.map((permission) => (
                <label key={permission} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={selected.has(permission)}
                    onChange={() => toggle(permission)}
                  />
                  {permission}
                </label>
              ))}
            </div>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            type="submit"
            disabled={submitting || !key || !name}
            className="self-start"
          >
            {submitting ? "Creating..." : "Create role"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
