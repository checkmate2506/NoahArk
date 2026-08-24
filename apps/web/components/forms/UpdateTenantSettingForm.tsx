"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Label } from "@noahark/ui";

export function UpdateTenantSettingForm({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const [language, setLanguage] = useState("EN");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/tenants/${tenantId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "ui.defaultLanguage", value: language }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? "Failed to update setting");
        return;
      }
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="default-language">Default UI language</Label>
        <select
          id="default-language"
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          <option value="EN">English</option>
          <option value="MS">Bahasa Melayu</option>
          <option value="ID">Bahasa Indonesia</option>
        </select>
      </div>
      <Button type="submit" disabled={submitting}>
        {submitting ? "Saving..." : "Save"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
