import { hash, verify } from "@node-rs/argon2";

export const PASSWORD_ALGORITHM = "argon2id";

const MIN_PASSWORD_LENGTH = 12;

export interface WeakPasswordResult {
  ok: boolean;
  reason?: string;
}

/** Minimal, honest strength check — length only. Phase 1 does not implement
 * a breached-password lookup or entropy scoring; that's a deliberate scope
 * cut, not an oversight. */
export function checkPasswordStrength(password: string): WeakPasswordResult {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    };
  }
  return { ok: true };
}

/** Argon2id is the package default (`@node-rs/argon2`'s `hash()` uses it
 * unless overridden) — matches CLAUDE.md's "Argon2id password hashing". */
export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  return verify(passwordHash, password);
}

/**
 * F-9 (Phase 1B): a fixed, precomputed Argon2id hash with no corresponding
 * real account — used by the sign-in route to run a verify() call of
 * identical computational cost when the submitted email does not match any
 * user, so the response-time difference between "wrong password for a
 * real account" and "no such account" stops being a reliable oracle for
 * enumerating registered emails. The dummy password itself is never used
 * or needed; only the hash's verification cost matters.
 */
export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$lt+7S0hl7T651Bc53lctvA$2hKGNS5MWQ9OqgMwxt3ReY8jO4p6FrAC+VsjbNEXcCw";
