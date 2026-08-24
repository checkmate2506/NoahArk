"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Input, Label } from "@noahark/ui";
import { sanitizeCallbackUrl } from "@/lib/safeRedirect";

export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function goToApp() {
    const callbackUrl = sanitizeCallbackUrl(searchParams.get("callbackUrl"));
    router.push(callbackUrl);
    router.refresh();
  }

  async function onSubmitPassword(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/auth/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "Sign-in failed");
        return;
      }
      if (body?.data?.mfaRequired) {
        setChallengeToken(body.data.challengeToken);
        return;
      }
      goToApp();
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmitMfa(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/auth/mfa/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeToken, code: mfaCode }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? "Verification failed");
        return;
      }
      goToApp();
    } finally {
      setSubmitting(false);
    }
  }

  if (challengeToken) {
    return (
      <form onSubmit={onSubmitMfa} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mfa-code">Verification code</Label>
          <Input
            id="mfa-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-digit code or recovery code"
            required
            value={mfaCode}
            onChange={(e) => setMfaCode(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={submitting} className="mt-2">
          {submitting ? "Verifying..." : "Verify"}
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={onSubmitPassword} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          required
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
        {submitting ? "Signing in..." : "Sign in"}
      </Button>
    </form>
  );
}
