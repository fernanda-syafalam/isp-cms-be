import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * Low-level AES-256-GCM encrypt/decrypt (authenticated encryption — a
 * tampered or truncated ciphertext fails to decrypt rather than silently
 * returning garbage). Shared by every "encrypt a secret at rest" use case in
 * the app: the 2FA TOTP secret (`TotpSecretCipherService`, F2) and the
 * per-router RouterOS API password (`RouterCredentialCipherService`,
 * SEC-M1). Pure functions, keyed by whatever 32-byte key the caller passes
 * in — no config/DI here, so each caller owns its own key-sourcing decision.
 *
 * Stored format: `iv:authTag:ciphertext`, each base64-encoded and
 * colon-joined, so the whole blob round-trips through a single `text`
 * column without a custom binary codec (`:` cannot appear inside base64
 * output, so it is a safe delimiter).
 */

/** Encrypt `plaintext` with `key` (must be exactly 32 raw bytes — AES-256). */
export function encryptAesGcm(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((buf) => buf.toString('base64')).join(':');
}

/**
 * Decrypt a value produced by `encryptAesGcm`. Never throws — returns
 * `null` (instead) for a value that is not in the `iv:authTag:ciphertext`
 * shape this function produces (e.g. a legacy plaintext value), or when
 * authentication fails (tampered/corrupted ciphertext, or a key that no
 * longer matches, e.g. after a rotation this function does not itself
 * support). Callers must fail closed on `null`, never fall back to treating
 * the stored value as plaintext.
 */
export function decryptAesGcm(key: Buffer, stored: string): string | null {
  const parts = stored.split(':');
  if (parts.length !== 3) return null;
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  try {
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const ciphertext = Buffer.from(ctB64, 'base64');
    if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) return null;
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    // GCM auth-tag mismatch, malformed base64, wrong key, etc. — all
    // treated the same: an unverifiable secret.
    return null;
  }
}
