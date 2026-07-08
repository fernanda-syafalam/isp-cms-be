import { type AddressInfo, type Server, type Socket, createServer } from 'node:net';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../config/configuration';
import type { RouterCredentialCipherService } from '../../routers/router-credential-cipher.service';
import type { RouterSecretTarget } from './router-adapter';
import { encodeSentence, parseSentences } from './routeros-protocol';
import { RouterOsRouterAdapter } from './routeros.adapter';

/**
 * A minimal fake RouterOS device: accepts a connection, decodes sentences
 * with the same pure protocol helpers the adapter uses, records every
 * `/login` sentence's `=password=` word (so tests can assert which
 * credential the adapter actually sent on the wire), and replies `!done` to
 * whatever it's sent so the adapter's flow completes quickly.
 */
function startFakeRouterOsServer(): Promise<{
  port: number;
  loginPasswords: string[];
  close: () => Promise<void>;
}> {
  const loginPasswords: string[] = [];
  return new Promise((resolve, reject) => {
    const server: Server = createServer((socket: Socket) => {
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const { sentences, consumed } = parseSentences(buf);
        buf = buf.subarray(consumed);
        for (const sentence of sentences) {
          if (sentence[0] === '/login') {
            const passwordWord = sentence.find((w) => w.startsWith('=password='));
            loginPasswords.push(passwordWord?.slice('=password='.length) ?? '');
          }
          // Every request this adapter sends (`/login`, `/ppp/secret/print`)
          // gets an empty `!done` — good enough to let the adapter's flow
          // finish (an empty print means "secret not found", a safe no-op).
          socket.write(encodeSentence(['!done']));
        }
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        loginPasswords,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function makeAdapter(
  sharedApiPassword: string | undefined,
  cipher: { decrypt: ReturnType<typeof vi.fn> },
): RouterOsRouterAdapter {
  const configStub = {
    get: () => sharedApiPassword,
  } as unknown as ConfigService<{ app: AppConfig }, true>;
  return new RouterOsRouterAdapter(configStub, cipher as unknown as RouterCredentialCipherService);
}

describe('RouterOsRouterAdapter (SEC-M1)', () => {
  let server: { port: number; loginPasswords: string[]; close: () => Promise<void> };
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    server = await startFakeRouterOsServer();
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    await server.close();
  });

  const targetFor = (overrides: Partial<RouterSecretTarget> = {}): RouterSecretTarget => ({
    host: '127.0.0.1',
    apiPort: server.port,
    routerUser: 'api',
    apiPasswordEncrypted: null,
    secretUsername: 'cust1001',
    ...overrides,
  });

  it('uses the per-router decrypted credential when present, not the shared env password', async () => {
    const cipher = { decrypt: vi.fn().mockReturnValue('per-router-pass') };
    const adapter = makeAdapter('shared-env-pass', cipher);

    await adapter.setSecretDisabled(targetFor({ apiPasswordEncrypted: 'iv:tag:ct' }), true);

    expect(cipher.decrypt).toHaveBeenCalledWith('iv:tag:ct');
    expect(server.loginPasswords).toEqual(['per-router-pass']);
    // No "shared fallback" nudge — a per-router credential was used.
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('shared ROUTEROS_API_PASSWORD fallback'),
    );
  });

  it('falls back to the shared env password when the router has no per-router credential, and logs a warning', async () => {
    const cipher = { decrypt: vi.fn() };
    const adapter = makeAdapter('shared-env-pass', cipher);

    await adapter.setSecretDisabled(targetFor({ apiPasswordEncrypted: null }), true);

    expect(cipher.decrypt).not.toHaveBeenCalled();
    expect(server.loginPasswords).toEqual(['shared-env-pass']);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ host: '127.0.0.1' }),
      expect.stringContaining('shared ROUTEROS_API_PASSWORD fallback'),
    );
  });

  it('fails closed (does NOT fall back to the shared password) when a stored credential fails to decrypt', async () => {
    const cipher = { decrypt: vi.fn().mockReturnValue(null) };
    const adapter = makeAdapter('shared-env-pass', cipher);

    await adapter.setSecretDisabled(targetFor({ apiPasswordEncrypted: 'corrupted-blob' }), true);

    expect(cipher.decrypt).toHaveBeenCalledWith('corrupted-blob');
    // Never connects with the shared password on a decrypt failure.
    expect(server.loginPasswords).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ host: '127.0.0.1' }),
      expect.stringContaining('failing closed'),
    );
  });

  it('skips the push (no connection attempt) when there is neither a per-router credential nor a shared password', async () => {
    const cipher = { decrypt: vi.fn() };
    const adapter = makeAdapter(undefined, cipher);

    await adapter.setSecretDisabled(targetFor({ apiPasswordEncrypted: null }), true);

    expect(server.loginPasswords).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ host: '127.0.0.1' }),
      expect.stringContaining('no usable API password'),
    );
  });
});
