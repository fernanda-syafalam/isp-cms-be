import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config/configuration';
import { TotpSecretCipherService } from './totp-secret-cipher.service';

const KEY_A = 'vnteJd7CUd7akqlbonvugRw6MNVSqV88K3ijn82XeoM=';
const KEY_B = 'xiLifU//0KCBCJD2I0TkqbdOh8a8Pt4zDR1J2j74+EI=';

function makeCipher(keyBase64: string): TotpSecretCipherService {
  const configStub = { get: () => keyBase64 } as unknown as ConfigService<{ app: AppConfig }, true>;
  return new TotpSecretCipherService(configStub);
}

describe('TotpSecretCipherService', () => {
  const plaintext = 'JBSWY3DPEHPK3PXP'; // a base32 TOTP secret

  it('round-trips a secret through encrypt/decrypt', () => {
    const cipher = makeCipher(KEY_A);
    const stored = cipher.encrypt(plaintext);
    expect(cipher.decrypt(stored)).toBe(plaintext);
  });

  it('never stores the plaintext directly — the blob is a different shape', () => {
    const cipher = makeCipher(KEY_A);
    const stored = cipher.encrypt(plaintext);
    expect(stored).not.toBe(plaintext);
    expect(stored).not.toContain(plaintext);
    expect(stored.split(':')).toHaveLength(3); // iv:authTag:ciphertext
  });

  it('produces a different ciphertext each time (random IV), both still decrypting correctly', () => {
    const cipher = makeCipher(KEY_A);
    const a = cipher.encrypt(plaintext);
    const b = cipher.encrypt(plaintext);
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a)).toBe(plaintext);
    expect(cipher.decrypt(b)).toBe(plaintext);
  });

  it('returns null (does not throw) for a legacy plaintext value', () => {
    const cipher = makeCipher(KEY_A);
    expect(cipher.decrypt(plaintext)).toBeNull();
  });

  it('returns null (does not throw) for a malformed blob', () => {
    const cipher = makeCipher(KEY_A);
    expect(cipher.decrypt('not-the-right-shape')).toBeNull();
    expect(cipher.decrypt('a:b')).toBeNull();
    expect(cipher.decrypt('a:b:c:d')).toBeNull();
    expect(cipher.decrypt('')).toBeNull();
  });

  it('returns null (does not throw) when the auth tag has been tampered with', () => {
    const cipher = makeCipher(KEY_A);
    const stored = cipher.encrypt(plaintext);
    const [iv, , ciphertext] = stored.split(':') as [string, string, string];
    const tampered = [iv, Buffer.alloc(16, 1).toString('base64'), ciphertext].join(':');
    expect(cipher.decrypt(tampered)).toBeNull();
  });

  it('returns null (does not throw) when decrypted with the wrong key', () => {
    const stored = makeCipher(KEY_A).encrypt(plaintext);
    expect(makeCipher(KEY_B).decrypt(stored)).toBeNull();
  });
});
