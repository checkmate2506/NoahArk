import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * F-3B: encrypts the TOTP secret at rest using AES-256-GCM, with a
 * purpose-specific key DERIVED from AUTH_SECRET (SHA-256 of AUTH_SECRET +
 * a fixed label) — the same key-separation pattern already used for the
 * file-signing key (apps/web's fileServiceWrapper.ts) and platform audit
 * context, rather than introducing a second required secret env var for a
 * single-secret Phase 1 deployment.
 *
 * A raw TOTP secret grants indefinite MFA bypass if ever read from a
 * backup/leak, unlike a password (which is hashed, not merely encrypted) —
 * encryption at rest is the appropriate control here specifically because
 * the running application legitimately needs the PLAINTEXT secret back to
 * compute codes for comparison (unlike passwords, which are never compared
 * in plaintext).
 */

function deriveKey(authSecret: string): Buffer {
  return createHash("sha256")
    .update(authSecret)
    .update("noahark:mfa-secret-encryption")
    .digest();
}

export function encryptMfaSecret(
  plaintextBase32Secret: string,
  authSecret: string,
): string {
  const key = deriveKey(authSecret);
  const iv = randomBytes(12); // GCM standard IV length
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintextBase32Secret, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  // iv.authTag.ciphertext, each base64url — self-contained, no external state needed to decrypt.
  return `${iv.toString("base64url")}.${authTag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptMfaSecret(encrypted: string, authSecret: string): string {
  const [ivB64, tagB64, ciphertextB64] = encrypted.split(".");
  if (!ivB64 || !tagB64 || !ciphertextB64)
    throw new Error("Malformed encrypted MFA secret");
  const key = deriveKey(authSecret);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64url")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
