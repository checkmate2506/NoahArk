"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Input, Label } from "@noahark/ui";
import { sanitizeCallbackUrl } from "@/lib/safeRedirect";

export function AcceptInvitationForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          password: password || undefined,
          name: name || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? "Failed to accept invitation");
        return;
      }
      router.push(sanitizeCallbackUrl(null, "/app"));
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <p className="text-sm text-destructive">
        This invitation link is missing its token.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="accept-name">Name (optional)</Label>
        <Input id="accept-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="accept-password">
          Password (required only if you don&apos;t already have a NoahArk account)
        </Label>
        <Input
          id="accept-password"
          type="password"
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={submitting} className="mt-2">
        {submitting ? "Accepting..." : "Accept invitation"}
      </Button>
    </form>
  );
}
