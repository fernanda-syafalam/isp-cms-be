import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decryptAesGcm, encryptAesGcm } from '../../common/security/aes-gcm-cipher';
import type { AppConfig } from '../../config/configuration';

/**
 * SEC-M1: encrypts/decrypts a router's per-device RouterOS API password at
 * rest with AES-256-GCM (same primitive as `TotpSecretCipherService` — see
 * `src/common/security/aes-gcm-cipher.ts`). Backs the fix for the shared-
 * credential SSRF finding: `routers.api_password_encrypted` replaces the
 * single `ROUTEROS_API_PASSWORD` env secret sent to EVERY router, so a
 * malicious/attacker-controlled `host` on one router record can no longer
 * exfiltrate the password to every other real device.
 *
 * Key choice: reuses `TWOFA_ENC_KEY` rather than introducing a second env
 * secret. Acceptable for v1 — this is already the app's one "encrypt a
 * secret at rest" key (kept separate from `DATABASE_URL` for the same
 * reason as F2: a DB-only dump does not also leak it), and per-router
 * password isolation (this feature) is the primary mitigation, not key
 * separation between 2FA and router secrets. Revisit (dedicated
 * `ROUTER_ENC_KEY`) if/when key rotation needs to be scoped independently
 * per secret class.
 *
 * `decrypt` never throws — see `decryptAesGcm`. The live adapter
 * (`RouterOsRouterAdapter`) treats a `null` result the same as "no
 * credential stored" and fails closed (does NOT fall back to the shared env
 * password for a router with a corrupted/unrotatable stored value — only
 * for one that genuinely never had a per-router credential set).
 */
@Injectable()
export class RouterCredentialCipherService {
  private readonly key: Buffer;

  constructor(config: ConfigService<{ app: AppConfig }, true>) {
    const encKeyBase64: string = config.get('app.twoFactor.encKey', { infer: true });
    this.key = Buffer.from(encKeyBase64, 'base64');
  }

  /** Encrypt a router's API password for storage. Always succeeds (or throws on a misconfigured key). */
  encrypt(plaintext: string): string {
    return encryptAesGcm(this.key, plaintext);
  }

  /** Decrypt a stored router API password. Returns `null` (never throws) on a malformed/tampered/unverifiable blob. */
  decrypt(stored: string): string | null {
    return decryptAesGcm(this.key, stored);
  }
}
