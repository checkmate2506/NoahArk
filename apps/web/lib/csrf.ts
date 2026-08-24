import { ForbiddenError } from "@noahark/core";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * F-8 (Phase 1B): Origin-header validation for cookie-authenticated
 * state-changing requests. `SameSite=Lax` (the session cookie's own
 * setting — see session.ts) already blocks classic cross-site `<form>`
 * POSTs, but provides no protection against a same-site or subdomain
 * attacker, which becomes material the moment tenant subdomains exist.
 * This is defense-in-depth on top of that, not a replacement.
 *
 * Trusted origins come from AUTH_URL (always trusted — the app's own
 * canonical origin) plus an optional comma-separated TRUSTED_ORIGINS env
 * var for any additional origin that legitimately needs to call these
 * APIs. Fails CLOSED in production (missing/mismatched Origin is
 * rejected); in development, a request with NO Origin header at all is
 * allowed through (curl/Postman/server-to-server tooling routinely omits
 * it), but a PRESENT, mismatched Origin is still rejected everywhere —
 * this asymmetry only ever loosens a missing-header case, never a
 * wrong-origin case.
 */
export function trustedOriginsFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const origins = new Set<string>();
  if (env.AUTH_URL) {
    try {
      origins.add(new URL(env.AUTH_URL).origin);
    } catch {
      // Malformed AUTH_URL is a startup-time config error caught elsewhere
      // (packages/config's env schema) — nothing to add here.
    }
  }
  for (const raw of (env.TRUSTED_ORIGINS ?? "").split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      // Ignore a malformed entry rather than crash request handling on it.
    }
  }
  return origins;
}

export function assertTrustedOrigin(
  req: Request,
  trustedOrigins: Set<string> = trustedOriginsFromEnv(),
  isProduction: boolean = process.env.NODE_ENV === "production",
): void {
  if (!STATE_CHANGING_METHODS.has(req.method)) return;

  const origin = req.headers.get("origin");
  if (!origin) {
    if (isProduction) {
      throw new ForbiddenError("Missing Origin header on a state-changing request");
    }
    return; // dev/test tooling routinely omits Origin — see doc comment above
  }

  if (!trustedOrigins.has(origin)) {
    throw new ForbiddenError("Request Origin is not trusted for this operation");
  }
}
