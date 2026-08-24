import { createHash, randomBytes } from "node:crypto";

const RECOVERY_CODE_COUNT = 10;

/** Human-typeable-ish (base32, hyphenated) single-use recovery codes.
 * Returned to the caller ONCE at enrolment time — only their SHA-256
 * hashes are ever persisted (packages/db's MfaRecoveryCode model), the
 * same pattern as every other credential in this codebase. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(5).toString("hex").toUpperCase(); // 10 hex chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}
