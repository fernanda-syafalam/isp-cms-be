import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * F2: encrypts/decrypts the TOTP secret at rest with AES-256-GCM
 * (authenticated encryption — a tampered or truncated ciphertext fails to
 * decrypt rather than silently returning garbage). The key comes from
 * `TWOFA_ENC_KEY` (env / secret manager — see `env.schema.ts` for its
 * validation) and is intentionally kept separate from `DATABASE_URL`: a
 * DB-only compromise (a dump, a read replica leak) does not also hand
 * over the means to decrypt every stored secret.
 *
 * Stored format: `iv:authTag:ciphertext`, each base64-encoded and
 * colon-joined, so the whole blob round-trips through a single `text`
 * column without a custom binary codec (`:` cannot appear inside base64
 * output, so it is a safe delimiter).
 *
 * `decrypt` never throws — a legacy plaintext value (stored before this
 * feature shipped) or a corrupted blob returns `null` so the caller
 * (`SecurityService`) can fail the 2FA challenge safely instead of
 * crashing. This is the ONLY place in the codebase that touches the raw
 * key or plaintext secret; never log either from here.
 */
@Injectable()
export class TotpSecretCipherService {
  private readonly key: Buffer;

  constructor(config: ConfigService<{ app: AppConfig }, true>) {
    const encKeyBase64: string = config.get('app.twoFactor.encKey', { infer: true });
    this.key = Buffer.from(encKeyBase64, 'base64');
  }

  /** Encrypt a base32 TOTP secret for storage. Always succeeds (or throws on a misconfigured key). */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv, authTag, ciphertext].map((buf) => buf.toString('base64')).join(':');
  }

  /**
   * Decrypt a stored value back to the base32 secret. Returns `null`
   * (never throws) when the value is not in the `iv:authTag:ciphertext`
   * shape this service produces (e.g. a pre-F2 plaintext secret) or when
   * authentication fails (tampered/corrupted ciphertext, or a key that no
   * longer matches — e.g. after a rotation this service does not yet
   * support).
   */
  decrypt(stored: string): string | null {
    const parts = stored.split(':');
    if (parts.length !== 3) return null;
    const [ivB64, tagB64, ctB64] = parts as [string, string, string];
    try {
      const iv = Buffer.from(ivB64, 'base64');
      const authTag = Buffer.from(tagB64, 'base64');
      const ciphertext = Buffer.from(ctB64, 'base64');
      if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) return null;
      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext.toString('utf8');
    } catch {
      // GCM auth-tag mismatch, malformed base64, wrong key, etc. — all
      // treated the same: an unverifiable secret. The caller logs this
      // (with userId context, never the value) before failing closed.
      return null;
    }
  }
}
