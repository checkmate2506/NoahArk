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

export function SubmitDemoApprovalForm({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/tenants/${tenantId}/approvals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? "Failed to submit");
        return;
      }
      setTitle("");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Submit demo request</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="demo-title">Title</Label>
            <Input
              id="demo-title"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={submitting || !title}>
            {submitting ? "Submitting..." : "Submit for approval"}
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
