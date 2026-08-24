const DEFAULT_REDIRECT = "/app";

/**
 * F-5 (Phase 1B): validates a client-supplied `callbackUrl` and returns a
 * value that is GUARANTEED same-origin-relative, or the safe default.
 *
 * The sign-in form previously called `router.push(callbackUrl)` with the
 * raw query-string value — `/sign-in?callbackUrl=https://evil.example`
 * redirected an authenticated user off-site immediately after a successful
 * login, a high-credibility phishing hand-off. Only a same-origin relative
 * path is ever accepted; anything else (absolute URL, protocol-relative
 * `//host`, backslash tricks, or a value that decodes into either of those)
 * falls back to `/app`.
 */
export function sanitizeCallbackUrl(
  raw: string | null | undefined,
  fallback = DEFAULT_REDIRECT,
): string {
  if (!raw) return fallback;

  const trimmed = raw.trim();
  if (!isSafeRelativePath(trimmed)) return fallback;

  // Reject a value that only becomes unsafe after percent-decoding (e.g.
  // "/%2F%2Fevil.example" decodes to "//evil.example"). A decode failure
  // (malformed percent-encoding) is itself treated as unsafe.
  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    return fallback;
  }
  if (!isSafeRelativePath(decoded)) return fallback;

  return trimmed;
}

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0) return false;
  // Must start with exactly one "/" — not "//" (protocol-relative,
  // browsers treat as an absolute URL using the current scheme) and not
  // "/\" (some browsers normalize a leading backslash to a second
  // forward slash, making "/\evil.example" behave like "//evil.example").
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//")) return false;
  if (value.startsWith("/\\")) return false;
  return true;
}
