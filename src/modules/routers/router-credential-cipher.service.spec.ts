import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config/configuration';
import { RouterCredentialCipherService } from './router-credential-cipher.service';

const KEY_A = 'vnteJd7CUd7akqlbonvugRw6MNVSqV88K3ijn82XeoM=';
const KEY_B = 'xiLifU//0KCBCJD2I0TkqbdOh8a8Pt4zDR1J2j74+EI=';

function makeCipher(keyBase64: string): RouterCredentialCipherService {
  const configStub = { get: () => keyBase64 } as unknown as ConfigService<{ app: AppConfig }, true>;
  return new RouterCredentialCipherService(configStub);
}

describe('RouterCredentialCipherService (SEC-M1)', () => {
  const plaintext = 'S3cur3-RouterOS-Pass!';

  it('round-trips a router API password through encrypt/decrypt', () => {
    const cipher = makeCipher(KEY_A);
    const stored = cipher.encrypt(plaintext);
    expect(cipher.decrypt(stored)).toBe(plaintext);
  });

  it('is encrypted at rest — the stored blob never contains the plaintext', () => {
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

  it('returns null (does not throw, fails closed) for a malformed blob', () => {
    const cipher = makeCipher(KEY_A);
    expect(cipher.decrypt('not-the-right-shape')).toBeNull();
    expect(cipher.decrypt('a:b')).toBeNull();
    expect(cipher.decrypt('')).toBeNull();
  });

  it('returns null (does not throw, fails closed) when decrypted with the wrong key', () => {
    const stored = makeCipher(KEY_A).encrypt(plaintext);
    expect(makeCipher(KEY_B).decrypt(stored)).toBeNull();
  });

  it('returns null (does not throw, fails closed) when the auth tag has been tampered with', () => {
    const cipher = makeCipher(KEY_A);
    const stored = cipher.encrypt(plaintext);
    const [iv, , ciphertext] = stored.split(':') as [string, string, string];
    const tampered = [iv, Buffer.alloc(16, 1).toString('base64'), ciphertext].join(':');
    expect(cipher.decrypt(tampered)).toBeNull();
  });
});
