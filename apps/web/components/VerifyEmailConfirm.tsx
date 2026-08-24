"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

export function VerifyEmailConfirm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [state, setState] = useState<"pending" | "ok" | "error">("pending");
  // The confirm token is single-use — a second POST for the same token
  // always fails even when the first one succeeded. React (StrictMode in
  // dev, and in principle any effect re-run) can invoke this effect twice
  // for the same mount; without this guard, whichever of the two responses
  // resolves LAST decides the displayed state, which could show "invalid"
  // to a user whose email genuinely was just verified by the first call.
  const requestedRef = useRef(false);

  useEffect(() => {
    if (!token) {
      setState("error");
      return;
    }
    if (requestedRef.current) return;
    requestedRef.current = true;
    fetch("/api/v1/auth/verify-email/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then((res) => setState(res.ok ? "ok" : "error"))
      .catch(() => setState("error"));
  }, [token]);

  if (state === "pending")
    return <p className="text-sm text-muted-foreground">Verifying...</p>;
  if (state === "ok")
    return <p className="text-sm">Your email has been verified. You may sign in now.</p>;
  return (
    <p className="text-sm text-destructive">
      This verification link is invalid or has expired.
    </p>
  );
}
