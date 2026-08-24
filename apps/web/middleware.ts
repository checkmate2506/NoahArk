import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/constants";

/**
 * Edge-safe, coarse redirect ONLY — checks whether a session cookie is
 * present, nothing more. This is NOT the authorization boundary: it cannot
 * validate the session against the database (no DB access on the Edge
 * runtime), so a forged/expired cookie still reaches the page. The
 * authoritative check is server-side in every page/API route via
 * requireCurrentUser()/getAccessContext() (lib/context.ts), which always
 * re-validates against the database. UI redirects are a convenience, not a
 * security control (SECURITY_AND_TENANCY.md: "UI visibility is not
 * authorization").
 *
 * F-21 (Phase 1B) note: a per-request CSP nonce was attempted here and
 * reverted — see next.config.ts's doc comment for why (Next.js only
 * applies a nonce to dynamically-rendered pages, and this app's public
 * pages are statically prerendered at build time; verified directly by
 * inspecting served script tags, which had no nonce attribute despite the
 * header carrying one).
 */
export function middleware(request: NextRequest): NextResponse {
  const hasSessionCookie = request.cookies.has(SESSION_COOKIE_NAME);
  if (!hasSessionCookie) {
    const signInUrl = new URL("/sign-in", request.url);
    signInUrl.searchParams.set("callbackUrl", request.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/app/:path*"],
};
