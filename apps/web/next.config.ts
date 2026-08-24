import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";

/**
 * F-21 (Phase 1B): baseline security headers — none existed before.
 *
 * CSP nonce trade-off (documented, not an oversight): a per-request
 * nonce-based CSP (`script-src 'self' 'nonce-...' 'strict-dynamic'`, no
 * `unsafe-inline`) was implemented and tested first, via middleware
 * setting `x-nonce` + a matching `Content-Security-Policy` request/response
 * header (Next.js's documented pattern). It broke the app: Next.js only
 * attaches a nonce to a page's injected scripts when that page is
 * DYNAMICALLY rendered per-request — this app's public pages (/sign-in,
 * /invitations/accept, /verify-email) are statically prerendered at build
 * time, so no request/response headers exist yet when they're generated
 * and no nonce can ever reach their script tags. Verified directly: with
 * the nonce CSP active, the browser console showed every Next.js chunk
 * script blocked, and the app failed to hydrate at all (React error #412).
 * Making the fix (forcing dynamic rendering on every route via
 * `export const dynamic = 'force-dynamic'` or `await connection()`) is a
 * broader change — it disables static optimization/ISR site-wide and
 * needs verification across all ~35 routes — than is safe to make as a
 * drive-by part of this security-hardening pass. `script-src
 * 'self' 'unsafe-inline'` is Next.js's own documented default path for
 * exactly this situation ("Without Nonces" in
 * node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md)
 * and is the pragmatic choice here: this app has no other realistic
 * inline-script injection vector (React escapes all output by default,
 * `dangerouslySetInnerHTML` is not used anywhere in the codebase), so the
 * residual risk `unsafe-inline` accepts is narrow. A later phase should
 * revisit nonce-based CSP alongside deliberately forcing dynamic rendering.
 *
 * `frame-ancestors 'none'` + `X-Frame-Options: DENY` block this app from
 * ever being framed (clickjacking on the admin UI's role/approval
 * controls) — both headers are static and need no nonce.
 */
function contentSecurityPolicy(): string {
  const scriptSrc = isProduction
    ? "'self' 'unsafe-inline'"
    : "'self' 'unsafe-inline' 'unsafe-eval'";
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy() },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // No known use for any of these in a Phase 1 admin app — deny by default.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
  ...(isProduction
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: false },
  // Server-only packages that touch native/Node-specific APIs (pg driver,
  // argon2 bindings) must not be bundled for the client.
  serverExternalPackages: ["@node-rs/argon2", "pg"],
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        // API responses may carry tenant data or session-adjacent state —
        // never cached by a browser or intermediary proxy.
        source: "/api/:path*",
        headers: [
          ...securityHeaders,
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
