import { type Socket, connect } from 'node:net';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/configuration';
import { RouterCredentialCipherService } from '../../routers/router-credential-cipher.service';
import { RouterAdapter, type RouterSecretTarget } from './router-adapter';
import { encodeSentence, parseSentences } from './routeros-protocol';

const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Live enforcement (`ROUTEROS_MODE=live`). Talks the RouterOS API binary
 * protocol over a plain TCP socket (post-6.43 login: username + password in
 * one `/login` sentence), then disables/enables a PPPoE secret by name:
 * `/ppp/secret/print ?name=<u>` → `.id`, then `/ppp/secret/set =.id=<id>
 * =disabled=yes|no`.
 *
 * SEC-M1 credential resolution: prefers the target router's own encrypted
 * credential (`RouterCredentialCipherService.decrypt`) so a compromised or
 * misdirected (malicious `host`) password only ever exposes ONE router.
 * Falls back to the shared env `ROUTEROS_API_PASSWORD` ONLY when the router
 * genuinely has no per-router credential stored yet (`apiPasswordEncrypted`
 * is `null`) — logging a warning nudge to migrate it. A router that DOES
 * have a stored credential but fails to decrypt (corrupted blob / rotated
 * key) fails closed instead — it does NOT silently fall back to the shared
 * secret, which would defeat the isolation this fix provides.
 *
 * Best-effort by contract: a device/connection failure is logged and swallowed
 * so a billing batch is never aborted by one unreachable router — the DB
 * already holds the intended state for a later reconcile.
 */
@Injectable()
export class RouterOsRouterAdapter extends RouterAdapter {
  private readonly logger = new Logger(RouterOsRouterAdapter.name);
  private readonly sharedApiPassword: string | undefined;

  constructor(
    config: ConfigService<{ app: AppConfig }, true>,
    private readonly cipher: RouterCredentialCipherService,
  ) {
    super();
    this.sharedApiPassword = config.get('app.routeros.apiPassword', { infer: true });
  }

  async setSecretDisabled(target: RouterSecretTarget, disabled: boolean): Promise<void> {
    const apiPassword = this.resolveApiPassword(target);
    if (!apiPassword) {
      this.logger.error(
        { host: target.host },
        'ROUTEROS_MODE=live but no usable API password (no per-router credential and ROUTEROS_API_PASSWORD is unset) — skipping push',
      );
      return;
    }

    let session: RouterOsSession | undefined;
    try {
      session = await RouterOsSession.open(target.host, target.apiPort);
      await session.login(target.routerUser, apiPassword);
      const id = await session.findSecretId(target.secretUsername);
      if (!id) {
        this.logger.warn(
          { host: target.host, secret: target.secretUsername },
          'PPPoE secret not found on router — nothing to enforce',
        );
        return;
      }
      await session.setSecretDisabled(id, disabled);
      this.logger.log(
        { host: target.host, secret: target.secretUsername, disabled },
        'pushed PPPoE secret disabled state to router',
      );
    } catch (err) {
      this.logger.error(
        {
          host: target.host,
          secret: target.secretUsername,
          err: err instanceof Error ? err.message : String(err),
        },
        'failed to push secret state to router — DB state stands for reconcile',
      );
    } finally {
      session?.close();
    }
  }

  /**
   * Resolve the plaintext password to authenticate with (SEC-M1). See the
   * class doc comment for the fail-closed-on-corruption rationale.
   */
  private resolveApiPassword(target: RouterSecretTarget): string | undefined {
    if (target.apiPasswordEncrypted) {
      const decrypted = this.cipher.decrypt(target.apiPasswordEncrypted);
      if (decrypted) return decrypted;
      this.logger.error(
        { host: target.host },
        'stored router API credential failed to decrypt (corrupted value or rotated key) — failing closed, NOT falling back to the shared password',
      );
      return undefined;
    }
    if (this.sharedApiPassword) {
      this.logger.warn(
        { host: target.host },
        'router has no per-router API credential — using the shared ROUTEROS_API_PASSWORD fallback (SEC-M1: migrate this router to a per-router credential via PATCH /v1/routers/:id)',
      );
    }
    return this.sharedApiPassword;
  }
}

/**
 * A single RouterOS API request/reply socket session. Thin: opens, sends one
 * sentence at a time and collects reply sentences until the terminating
 * `!done`/`!trap`. Not exported — the adapter is the only consumer.
 */
class RouterOsSession {
  private buffer = Buffer.alloc(0);

  private constructor(private readonly socket: Socket) {}

  static open(host: string, port: number): Promise<RouterOsSession> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port, timeout: CONNECT_TIMEOUT_MS });
      socket.once('connect', () => {
        socket.setTimeout(0);
        resolve(new RouterOsSession(socket));
      });
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error('router connection timed out'));
      });
      socket.once('error', reject);
    });
  }

  async login(user: string, password: string): Promise<void> {
    const reply = await this.send(['/login', `=name=${user}`, `=password=${password}`]);
    if (reply.some((s) => s[0] === '!trap')) {
      throw new Error('router login rejected');
    }
  }

  async findSecretId(username: string): Promise<string | null> {
    const reply = await this.send(['/ppp/secret/print', `?name=${username}`]);
    for (const sentence of reply) {
      const idWord = sentence.find((w) => w.startsWith('=.id='));
      if (idWord) return idWord.slice('=.id='.length);
    }
    return null;
  }

  async setSecretDisabled(id: string, disabled: boolean): Promise<void> {
    const reply = await this.send([
      '/ppp/secret/set',
      `=.id=${id}`,
      `=disabled=${disabled ? 'yes' : 'no'}`,
    ]);
    if (reply.some((s) => s[0] === '!trap')) {
      throw new Error('router rejected secret set');
    }
  }

  close(): void {
    this.socket.destroy();
  }

  /** Send one sentence and collect reply sentences until `!done`/`!fatal`. */
  private send(words: string[]): Promise<string[][]> {
    return new Promise((resolve, reject) => {
      const collected: string[][] = [];
      const onData = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const { sentences, consumed } = parseSentences(this.buffer);
        this.buffer = this.buffer.subarray(consumed);
        for (const sentence of sentences) {
          collected.push(sentence);
          if (sentence[0] === '!done' || sentence[0] === '!fatal') {
            this.socket.off('data', onData);
            this.socket.off('error', reject);
            resolve(collected);
            return;
          }
        }
      };
      this.socket.on('data', onData);
      this.socket.once('error', reject);
      this.socket.write(encodeSentence(words));
    });
  }
}
