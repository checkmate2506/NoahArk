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

const JURISDICTION_DEFAULTS: Record<
  string,
  { currency: string; timeZone: string; language: string }
> = {
  SG: { currency: "SGD", timeZone: "Asia/Singapore", language: "EN" },
  MY: { currency: "MYR", timeZone: "Asia/Kuala_Lumpur", language: "MS" },
  ID: { currency: "IDR", timeZone: "Asia/Jakarta", language: "ID" },
};

export function CreateLegalEntityForm({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [jurisdiction, setJurisdiction] = useState("SG");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const defaults = JURISDICTION_DEFAULTS[jurisdiction];
    try {
      const res = await fetch(`/api/v1/tenants/${tenantId}/legal-entities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          jurisdiction,
          functionalCurrency: defaults?.currency,
          timeZone: defaults?.timeZone,
          defaultLanguage: defaults?.language,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? "Failed to create legal entity");
        return;
      }
      setName("");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add legal entity</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="le-name">Name</Label>
            <Input
              id="le-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="le-jurisdiction">Jurisdiction</Label>
            <select
              id="le-jurisdiction"
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value)}
            >
              <option value="SG">Singapore (SGD)</option>
              <option value="MY">Malaysia (MYR)</option>
              <option value="ID">Indonesia (IDR)</option>
            </select>
          </div>
          <Button type="submit" disabled={submitting || !name}>
            {submitting ? "Creating..." : "Create"}
          </Button>
        </form>
        {error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
