import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decryptAesGcm, encryptAesGcm } from '../../common/security/aes-gcm-cipher';
import type { AppConfig } from '../../config/configuration';

/**
 * F2: encrypts/decrypts the TOTP secret at rest with AES-256-GCM (see
 * `src/common/security/aes-gcm-cipher.ts` for the shared cipher primitive —
 * also used by `RouterCredentialCipherService`, SEC-M1). The key comes from
 * `TWOFA_ENC_KEY` (env / secret manager — see `env.schema.ts` for its
 * validation) and is intentionally kept separate from `DATABASE_URL`: a
 * DB-only compromise (a dump, a read replica leak) does not also hand
 * over the means to decrypt every stored secret.
 *
 * `decrypt` never throws — a legacy plaintext value (stored before this
 * feature shipped) or a corrupted blob returns `null` so the caller
 * (`SecurityService`) can fail the 2FA challenge safely instead of
 * crashing. This is the ONLY place in the security module that touches the
 * raw key or plaintext secret; never log either from here.
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
    return encryptAesGcm(this.key, plaintext);
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
    return decryptAesGcm(this.key, stored);
  }
}
