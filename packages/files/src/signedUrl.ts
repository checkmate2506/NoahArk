import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * F-15 (Phase 1B.1): the signature now binds FIVE things, not two —
 * `fileId`, `storageKey`, `version`, `operation`, and `expiresAt`. The
 * previous design bound only `(storageKey, expiresAt)`, which meant a
 * signed URL kept working for its entire TTL even after the file was
 * soft-deleted (the storage key didn't change), and provided no way to
 * revoke a URL early short of rotating the whole signing secret. Binding
 * `version` (bumped on delete/quarantine/explicit revocation/content
 * replacement — see fileService.ts) makes every prior signed URL for a
 * file fail verification the instant any of those happen, without needing
 * to track individual issued URLs.
 */
export interface SignedFileAccessInput {
  fileId: string;
  storageKey: string;
  version: number;
  /** Currently only "download" — kept explicit (not inferred from the
   * route) so a future write-capable signed operation cannot be produced
   * by replaying a download signature; each operation has a distinct
   * signed payload. */
  operation: "download";
}

export interface SignedFileAccess {
  expiresAt: number;
  signature: string;
}

export function signFileAccess(
  input: SignedFileAccessInput,
  secret: string,
  ttlSeconds = 300,
): SignedFileAccess {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  return { expiresAt, signature: computeSignature(input, expiresAt, secret) };
}

/** Constant-time verification of the signature AND the expiry — the
 * expiry check happens before the signature comparison would leak nothing
 * either way, but ordering it first avoids doing the HMAC computation at
 * all for an already-expired link. Version/status/revocation checks are
 * the CALLER's responsibility (see `verifyAndReadSignedFile` in
 * apps/web) — this function only proves "this exact input tuple was
 * signed by us and hasn't expired," not "this file is still servable." */
export function verifyFileAccess(
  input: SignedFileAccessInput,
  expiresAt: number,
  signature: string,
  secret: string,
): boolean {
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  const expected = computeSignature(input, expiresAt, secret);
  return timingSafeEqualHex(signature, expected);
}

/** Exported separately so callers can validate a raw signature string's
 * shape (hex, expected length) BEFORE attempting a timing-safe compare —
 * `timingSafeEqual` throws on mismatched buffer lengths, which callers
 * must not let become an unhandled exception on malformed input. */
export function isWellFormedHexSignature(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value); // SHA-256 HMAC hex digest is always 64 hex chars
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (!isWellFormedHexSignature(a) || !isWellFormedHexSignature(b)) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function computeSignature(
  input: SignedFileAccessInput,
  expiresAt: number,
  secret: string,
): string {
  const payload = `${input.fileId}:${input.storageKey}:${input.version}:${input.operation}:${expiresAt}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}
