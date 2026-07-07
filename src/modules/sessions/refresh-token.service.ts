import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { RedisService } from '../../infrastructure/redis/redis.service';

interface StoredRefreshToken {
  userId: string;
  sessionId: string;
}

/** Everything captured about the request that minted or last used a session. */
export interface SessionMeta {
  userAgent: string;
  ip: string;
}

export interface MintedRefreshToken {
  token: string; // raw token returned to the client
  expiresInSeconds: number;
  sessionId: string;
}

/** One reviewable active session, as returned by `listSessions`. */
export interface SessionSummary {
  id: string;
  createdAt: string; // ISO 8601
  lastUsedAt: string; // ISO 8601
  userAgent: string;
  ip: string;
}

/** The JSON value stored under `session:<userId>:<sessionId>`. */
interface StoredSession {
  createdAt: string;
  lastUsedAt: string;
  userAgent: string;
  ip: string;
  // The exact `refresh:<hash>` Redis key currently backing this session —
  // lets a session-scoped revoke delete the matching token directly
  // without ever needing the raw token again.
  refreshKey: string;
}

/**
 * Opaque refresh tokens with single-use rotation, PLUS the per-user active
 * "session" bookkeeping (SEC-2) that the security page's session list and
 * revocation are backed by.
 *
 * The raw token is never stored — Redis holds only sha256(rawToken) as the
 * key, so a leaked Redis dump cannot be used to log in.
 *
 * Rotation pattern (each `/v1/auth/refresh` call):
 *   1. Lookup current token by its hash and atomically delete it
 *      (Redis GETDEL — atomic so a concurrent retry cannot both
 *      succeed and produce two valid descendants).
 *   2. If lookup misses, the token is unknown OR already rotated.
 *      Respond 401 either way.
 *   3. Mint a fresh refresh token bound to the SAME session id, return it
 *      to the client. The session's `lastUsedAt` (and `ip`/`userAgent`,
 *      when supplied) are updated in place — rotation never creates a new
 *      session row.
 *
 * Session bookkeeping layout in Redis:
 *   - `refresh:<sha256(token)>`   -> `{ userId, sessionId }` (existing key,
 *     now also carries the owning session id)
 *   - `session:<userId>:<id>`    -> `{ createdAt, lastUsedAt, userAgent,
 *     ip, refreshKey }`, same TTL as the refresh token it backs
 *   - `sessions:<userId>`        -> a Redis SET of that user's session ids
 *     (its own TTL is refreshed alongside every session touch so it decays
 *     with its members; individual ids that outlive their metadata are
 *     lazily pruned by `listSessions`/`revokeOtherSessions` rather than
 *     tracked with a per-member TTL, which Redis sets do not support)
 *
 * Out of scope for this service (left as follow-up for services
 * that need higher assurance):
 *   - Token "family" theft detection: when a stolen token is replayed
 *     after the legitimate user has already rotated it, the entire
 *     family is revoked. Implementation requires either reverse
 *     lookup or per-family Redis set — track issue if a service
 *     needs it.
 */
@Injectable()
export class RefreshTokenService {
  private static readonly REFRESH_PREFIX = 'refresh:';
  private static readonly SESSION_PREFIX = 'session:';
  private static readonly INDEX_PREFIX = 'sessions:';

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService<{ app: AppConfig }, true>,
  ) {}

  /**
   * Issue a brand-new refresh token bound to `userId`, and create the
   * session record it belongs to. Used by login/bootstrap.
   */
  async mint(userId: string, meta: SessionMeta): Promise<MintedRefreshToken> {
    const sessionId = randomUUID();
    const { token, key, expiresInSeconds } = await this.mintToken(userId, sessionId);
    await this.touchSession(userId, sessionId, key, meta);
    return { token, expiresInSeconds, sessionId };
  }

  /**
   * Trade an unused refresh token for a new one, bound to the SAME
   * session id. Throws UnauthorizedException for unknown /
   * already-rotated / expired tokens. `meta`, when supplied, refreshes
   * the session's recorded `ip`/`userAgent` — a refresh legitimately
   * moving IP (mobile network change) should be reflected, not frozen
   * at login time.
   */
  async rotate(
    rawToken: string,
    meta?: Partial<SessionMeta>,
  ): Promise<{ userId: string; sessionId: string; refresh: MintedRefreshToken }> {
    const key = this.refreshKey(rawToken);
    // GETDEL is atomic in Redis 6.2+, so a concurrent rotation race
    // returns the value to exactly one caller; everyone else sees
    // null and is rejected.
    const stored = await this.redis.client.getdel(key);
    if (!stored) {
      throw new UnauthorizedException('invalid refresh token');
    }
    const { userId, sessionId } = JSON.parse(stored) as StoredRefreshToken;
    const minted = await this.mintToken(userId, sessionId);
    await this.touchSession(userId, sessionId, minted.key, meta);
    return {
      userId,
      sessionId,
      refresh: { token: minted.token, expiresInSeconds: minted.expiresInSeconds, sessionId },
    };
  }

  /**
   * Best-effort logout — invalidate a specific refresh token and drop its
   * session record. Safe to call with an unknown token; returns silently.
   */
  async revoke(rawToken: string): Promise<void> {
    const key = this.refreshKey(rawToken);
    const stored = await this.redis.client.getdel(key);
    if (!stored) return;
    const { userId, sessionId } = JSON.parse(stored) as StoredRefreshToken;
    await this.forgetSession(userId, sessionId);
  }

  /**
   * List the caller's active sessions, newest-activity first. Session ids
   * whose metadata already expired (TTL elapsed) but are still lingering
   * in the per-user index are lazily pruned here rather than tracked with
   * a per-member Redis TTL (sets do not support one).
   */
  async listSessions(userId: string): Promise<SessionSummary[]> {
    const ids = await this.redis.client.smembers(this.indexKey(userId));
    const summaries: SessionSummary[] = [];
    const staleIds: string[] = [];
    for (const id of ids) {
      const raw = await this.redis.client.get(this.sessionKey(userId, id));
      if (!raw) {
        staleIds.push(id);
        continue;
      }
      const record = JSON.parse(raw) as StoredSession;
      summaries.push({
        id,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
        userAgent: record.userAgent,
        ip: record.ip,
      });
    }
    if (staleIds.length > 0) {
      await this.redis.client.srem(this.indexKey(userId), ...staleIds);
    }
    return summaries.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }

  /**
   * Revoke exactly one session: deletes its backing refresh token (so a
   * stolen token stops working immediately, not just the display row) and
   * its metadata. Returns whether a session actually matched — the
   * controller turns `false` into a 404.
   */
  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    const key = this.sessionKey(userId, sessionId);
    const raw = await this.redis.client.get(key);
    if (!raw) {
      // Nothing to revoke, but drop a stale index entry if one snuck in.
      await this.redis.client.srem(this.indexKey(userId), sessionId);
      return false;
    }
    const record = JSON.parse(raw) as StoredSession;
    await this.redis.client.del(record.refreshKey);
    await this.forgetSession(userId, sessionId);
    return true;
  }

  /**
   * Revoke every session for `userId` except `keepSessionId` (the caller's
   * own session, identified via the JWT `sid` claim — see JwtStrategy).
   * When `keepSessionId` is undefined (an old access token minted before
   * the claim existed), every session is revoked — degrades safely rather
   * than guessing which one is "current". Returns how many were revoked.
   */
  async revokeOtherSessions(userId: string, keepSessionId?: string): Promise<number> {
    const ids = await this.redis.client.smembers(this.indexKey(userId));
    let revoked = 0;
    for (const id of ids) {
      if (id === keepSessionId) continue;
      if (await this.revokeSession(userId, id)) revoked++;
    }
    return revoked;
  }

  // ---------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------

  /** Mint a fresh opaque token bound to an (existing or new) session id. */
  private async mintToken(
    userId: string,
    sessionId: string,
  ): Promise<{ token: string; key: string; expiresInSeconds: number }> {
    const token = randomBytes(32).toString('base64url');
    const key = this.refreshKey(token);
    const expiresInSeconds = this.ttlSeconds();
    const payload: StoredRefreshToken = { userId, sessionId };
    await this.redis.client.set(key, JSON.stringify(payload), 'EX', expiresInSeconds);
    return { token, key, expiresInSeconds };
  }

  /**
   * Upsert the session record: preserves `createdAt` across rotations,
   * updates `lastUsedAt` + (when supplied) `ip`/`userAgent`, and resets
   * the TTL to stay in lockstep with the refresh token that now backs it.
   */
  private async touchSession(
    userId: string,
    sessionId: string,
    refreshKey: string,
    meta?: Partial<SessionMeta>,
  ): Promise<void> {
    const ttl = this.ttlSeconds();
    const key = this.sessionKey(userId, sessionId);
    const existingRaw = await this.redis.client.get(key);
    const existing = existingRaw ? (JSON.parse(existingRaw) as StoredSession) : null;
    const now = new Date().toISOString();
    const record: StoredSession = {
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
      userAgent: meta?.userAgent ?? existing?.userAgent ?? 'unknown',
      ip: meta?.ip ?? existing?.ip ?? 'unknown',
      refreshKey,
    };
    await this.redis.client.set(key, JSON.stringify(record), 'EX', ttl);
    await this.redis.client.sadd(this.indexKey(userId), sessionId);
    // The index's own TTL trails the longest-lived member; refreshing it
    // on every touch keeps it from expiring while any member is still
    // alive (an idle index past this window is harmless — it holds only
    // ids, and `listSessions`/`revokeSession` already tolerate a stale one).
    await this.redis.client.expire(this.indexKey(userId), ttl);
  }

  private async forgetSession(userId: string, sessionId: string): Promise<void> {
    await this.redis.client.del(this.sessionKey(userId, sessionId));
    await this.redis.client.srem(this.indexKey(userId), sessionId);
  }

  private refreshKey(rawToken: string): string {
    const hash = createHash('sha256').update(rawToken).digest('hex');
    return `${RefreshTokenService.REFRESH_PREFIX}${hash}`;
  }

  private sessionKey(userId: string, sessionId: string): string {
    return `${RefreshTokenService.SESSION_PREFIX}${userId}:${sessionId}`;
  }

  private indexKey(userId: string): string {
    return `${RefreshTokenService.INDEX_PREFIX}${userId}`;
  }

  private ttlSeconds(): number {
    return this.config.get('app.jwt.refreshTokenTtlSeconds', { infer: true });
  }
}
