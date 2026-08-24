"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    await fetch("/api/v1/auth/sign-out", { method: "POST" }).finally(() =>
      setPending(false),
    );
    router.push("/sign-in");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="w-full rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
    >
      {pending ? "Signing out..." : "Sign out"}
    </button>
  );
}
