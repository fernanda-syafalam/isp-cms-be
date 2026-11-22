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
  // The `refresh:<hash>` key backing this session, so a revoke can delete it without the raw token.
  refreshKey: string;
}

/**
 * Opaque refresh tokens with single-use rotation, plus the per-user session bookkeeping (SEC-2)
 * behind the security page's session list and revocation.
 *
 * Redis holds only sha256(rawToken), so a leaked dump cannot be used to log in.
 * Rotation: GETDEL the old token (atomic, so a concurrent retry cannot mint two descendants);
 * a miss (unknown or already rotated) is 401. `COMMIT_SCRIPT` then mints a new token on the SAME
 * session id; a session revoked meanwhile yields 401.
 *
 * Keys: `refresh:<sha256>` -> {userId, sessionId}; `session:<userId>:<id>` -> session record
 * (same TTL); `sessions:<userId>` -> SET of ids, lazily pruned as sets lack per-member TTL.
 *
 * Revoke and commit are single Lua scripts so they cannot interleave: a revoked session must
 * never come back to life. See each script for its invariant.
 */
@Injectable()
export class RefreshTokenService {
  private static readonly REFRESH_PREFIX = 'refresh:';
  private static readonly SESSION_PREFIX = 'session:';
  private static readonly INDEX_PREFIX = 'sessions:';

  /**
   * Atomically revokes one session. KEYS = [sessionKey, indexKey], ARGV = [sessionId].
   * Deletes the CURRENT refresh token, record, and index entry in one step, so a concurrent
   * rotation cannot swap in a token this revoke misses. Returns 1 if revoked, 0 if nothing found
   * (stale index entry cleared either way).
   */
  private static readonly REVOKE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  redis.call('SREM', KEYS[2], ARGV[1])
  return 0
end
local record = cjson.decode(raw)
redis.call('DEL', record.refreshKey)
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[1])
return 1
`;

  /**
   * Atomically commits a (re)mint. KEYS = [newRefreshKey, indexKey, sessionKey],
   * ARGV = [requireExisting '0'|'1', sessionId, tokenPayloadJson, ttlSeconds, sessionRecordJson].
   * On rotation ('1') aborts without writing if the session left the index (revoked since the GETDEL);
   * check and write share one atomic step. Login always writes. Returns 1 on write, 0 on reject.
   */
  private static readonly COMMIT_SCRIPT = `
local requireExisting = ARGV[1]
if requireExisting == '1' then
  local isMember = redis.call('SISMEMBER', KEYS[2], ARGV[2])
  if isMember == 0 then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
redis.call('SET', KEYS[3], ARGV[5], 'EX', ARGV[4])
redis.call('SADD', KEYS[2], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[4])
return 1
`;

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService<{ app: AppConfig }, true>,
  ) {}

  /** Issues a new refresh token and its session record (login/bootstrap). */
  async mint(userId: string, meta: SessionMeta): Promise<MintedRefreshToken> {
    const sessionId = randomUUID();
    // requireExisting=false: a fresh session id cannot already be revoked.
    const minted = await this.commitMint(userId, sessionId, false, meta);
    if (!minted) {
      // Unreachable: a fresh session id cannot be revoked.
      throw new Error('failed to mint a new session — this should never happen');
    }
    return { token: minted.token, expiresInSeconds: minted.expiresInSeconds, sessionId };
  }

  /**
   * Trades an unused refresh token for a new one on the SAME session id. Unknown, already-rotated,
   * expired, or concurrently revoked (SEC-RACE) tokens throw Unauthorized. `meta` refreshes the
   * session's ip/userAgent so a legitimate IP change is not frozen at login.
   */
  async rotate(
    rawToken: string,
    meta?: Partial<SessionMeta>,
  ): Promise<{ userId: string; sessionId: string; refresh: MintedRefreshToken }> {
    const key = this.refreshKey(rawToken);
    // GETDEL is atomic: only one concurrent caller gets the value. The old token is consumed
    // even if the commit below is rejected (revoked session), so nothing live is left to roll back to.
    const stored = await this.redis.client.getdel(key);
    if (!stored) {
      throw new UnauthorizedException('invalid refresh token');
    }
    const { userId, sessionId } = JSON.parse(stored) as StoredRefreshToken;
    // requireExisting=true: never resurrect a session revoked since the GETDEL.
    const minted = await this.commitMint(userId, sessionId, true, meta);
    if (!minted) {
      throw new UnauthorizedException('invalid refresh token');
    }
    return {
      userId,
      sessionId,
      refresh: { token: minted.token, expiresInSeconds: minted.expiresInSeconds, sessionId },
    };
  }

  /**
   * Best-effort logout: consumes the token and drops its session. Unknown token resolves `null`.
   * Returns `userId` so AuthService can attribute the `auth.logout` audit row (R8-OBS-2).
   */
  async revoke(rawToken: string): Promise<{ userId: string } | null> {
    const key = this.refreshKey(rawToken);
    const stored = await this.redis.client.getdel(key);
    if (!stored) return null;
    const { userId, sessionId } = JSON.parse(stored) as StoredRefreshToken;
    await this.forgetSession(userId, sessionId);
    return { userId };
  }

  /** Lists active sessions, newest activity first; lazily prunes index ids whose metadata expired (Redis sets have no per-member TTL). */
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

  /** Revokes one session atomically (`REVOKE_SCRIPT`), killing its current refresh token too. `false` means no match (controller returns 404). */
  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.redis.client.eval(
      RefreshTokenService.REVOKE_SCRIPT,
      2,
      this.sessionKey(userId, sessionId),
      this.indexKey(userId),
      sessionId,
    );
    return result === 1;
  }

  /**
   * Revokes every session except `keepSessionId` (the caller's, from the JWT `sid` claim).
   * Without `keepSessionId` (old token lacking the claim) all are revoked rather than guessing.
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

  /**
   * Mints a token for `sessionId` and commits it via `COMMIT_SCRIPT`. With `requireExisting`
   * (rotation) returns null if the session was revoked meanwhile (SEC-RACE).
   * Display fields fall back to the existing record; a stale read is harmless because the
   * membership check runs inside the script.
   */
  private async commitMint(
    userId: string,
    sessionId: string,
    requireExisting: boolean,
    meta?: Partial<SessionMeta>,
  ): Promise<{ token: string; expiresInSeconds: number } | null> {
    const token = randomBytes(32).toString('base64url');
    const newRefreshKey = this.refreshKey(token);
    const ttl = this.ttlSeconds();
    const sessionKey = this.sessionKey(userId, sessionId);
    const existingRaw = await this.redis.client.get(sessionKey);
    const existing = existingRaw ? (JSON.parse(existingRaw) as StoredSession) : null;
    const now = new Date().toISOString();
    const tokenPayload: StoredRefreshToken = { userId, sessionId };
    const record: StoredSession = {
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
      userAgent: meta?.userAgent ?? existing?.userAgent ?? 'unknown',
      ip: meta?.ip ?? existing?.ip ?? 'unknown',
      refreshKey: newRefreshKey,
    };
    const result = await this.redis.client.eval(
      RefreshTokenService.COMMIT_SCRIPT,
      3,
      newRefreshKey,
      this.indexKey(userId),
      sessionKey,
      requireExisting ? '1' : '0',
      sessionId,
      JSON.stringify(tokenPayload),
      String(ttl),
      JSON.stringify(record),
    );
    if (result !== 1) return null;
    return { token, expiresInSeconds: ttl };
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
