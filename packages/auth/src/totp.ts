import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * F-3B (Phase 1B): TOTP (RFC 6238, built on HOTP — RFC 4226), implemented
 * directly against Node's built-in `crypto` rather than adding a new
 * dependency for a well-specified, independently-testable algorithm (see
 * totp.test.ts, verified against the RFC 4226 Appendix D test vectors).
 * 30-second time step, 6 digits, SHA-1 (the de-facto standard every
 * authenticator app — Google Authenticator, Authy, 1Password, etc. —
 * expects; RFC 6238 permits SHA-256/512 but interoperability in practice
 * means SHA-1 here).
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20)); // 160 bits, matches RFC 4226's test-vector length
}

export function base32Encode(buffer: Buffer): string {
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  const remainder = bits.length % 5;
  if (remainder > 0) {
    const lastChunk = bits.slice(bits.length - remainder).padEnd(5, "0");
    out += BASE32_ALPHABET[parseInt(lastChunk, 2)];
  }
  return out;
}

export function base32Decode(encoded: string): Buffer {
  const clean = encoded.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Invalid base32 character");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: bigint, digits: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const hmac = createHmac("sha1", secret).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binCode =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(binCode % 10 ** digits).padStart(digits, "0");
}

/** Computes the code for a given unix-seconds timestamp (defaults to now). */
export function computeTotp(
  base32Secret: string,
  atSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const counter = BigInt(Math.floor(atSeconds / STEP_SECONDS));
  return hotp(base32Decode(base32Secret), counter, DIGITS);
}

export interface TotpVerificationResult {
  valid: boolean;
  /** The RFC 4226 HOTP counter (floor(unixSeconds / 30)) that matched, or
   * `null` if nothing matched. Callers doing replay protection (N-1, Phase
   * 1D — see mfaService.ts) need this to enforce "this exact counter can
   * never be accepted again", which a plain boolean can't express. */
  counter: number | null;
}

/**
 * Verifies a submitted code, allowing one step of clock drift each way
 * (±30s) — standard practice for TOTP verification, since client and
 * server clocks are never perfectly synchronised (documented trade-off:
 * this widens the acceptance window to 3 codes at any instant, which is
 * why replay protection — rejecting an already-used counter, see
 * mfaService.ts — matters independently of this drift tolerance). Uses a
 * timing-safe comparison for each candidate, and always evaluates all
 * three candidates (no early-return on the first match) so response
 * timing cannot reveal WHICH drift position matched.
 */
export function verifyTotpWithCounter(
  base32Secret: string,
  submittedCode: string,
  atSeconds: number = Math.floor(Date.now() / 1000),
): TotpVerificationResult {
  const normalized = submittedCode.trim();
  if (!/^\d{6}$/.test(normalized)) return { valid: false, counter: null };
  let matchedCounter: number | null = null;
  for (const drift of [0, -1, 1]) {
    const candidateSeconds = atSeconds + drift * STEP_SECONDS;
    const counter = Math.floor(candidateSeconds / STEP_SECONDS);
    const candidate = hotp(base32Decode(base32Secret), BigInt(counter), DIGITS);
    if (timingSafeEqualStrings(candidate, normalized)) matchedCounter = counter;
  }
  return { valid: matchedCounter !== null, counter: matchedCounter };
}

/** Boolean-only convenience wrapper over {@link verifyTotpWithCounter} for
 * callers that don't need replay protection (e.g. MFA enrolment
 * confirmation, which has no prior counter to compare against yet). */
export function verifyTotp(
  base32Secret: string,
  submittedCode: string,
  atSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  return verifyTotpWithCounter(base32Secret, submittedCode, atSeconds).valid;
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** `otpauth://` provisioning URI for QR-code generation. Never logs the
 * secret — callers must display it only in the enrolment response body. */
export function buildProvisioningUri(
  base32Secret: string,
  accountEmail: string,
  issuer = "NoahArk",
): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  const params = new URLSearchParams({
    secret: base32Secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
