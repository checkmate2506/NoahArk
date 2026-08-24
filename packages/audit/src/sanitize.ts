/** Keys that must never appear in an audit event's before/after metadata,
 * regardless of which entity is being audited. Matched case-insensitively
 * (and separator-insensitively — see `normalizeKey` below) against object
 * keys at any depth. F-29 (Phase 1B): expanded past credential/token
 * synonyms to cover MFA material, cookies/headers, and the two national ID
 * formats NoahArk's jurisdictions use (NRIC for SG, NIK for ID) — an audit
 * snapshot of a User or profile-like record must never carry these even
 * incidentally. */
const DENYLIST = new Set([
  "password",
  "passwordhash",
  "token",
  "sessiontoken",
  "secret",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "salt",
  "otp",
  "totp",
  "totpsecret",
  "mfasecret",
  "recoverycode",
  "recoverycodes",
  "authorization",
  "cookie",
  "credential",
  "nric",
  "nik",
]);

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;

/** Structural match rather than exact spelling: lowercases and strips
 * every non-alphanumeric character, so "password_hash", "Password-Hash",
 * "passwordHash" and "PASSWORD HASH" all normalize to "passwordhash" and
 * match a single denylist entry. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Recursively strips values for denylisted keys and caps recursion depth, so
 * a caller can safely pass an entity snapshot straight into an audit event
 * without needing to remember to scrub secrets by hand every time.
 */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForAudit(item, depth + 1));
  }

  if (value instanceof Date) return value.toISOString();

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (DENYLIST.has(normalizeKey(key))) {
        out[key] = REDACTED;
      } else {
        out[key] = sanitizeForAudit(val, depth + 1);
      }
    }
    return out;
  }

  return value;
}
