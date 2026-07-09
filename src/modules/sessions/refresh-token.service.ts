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
 *   3. Atomically (see `COMMIT_SCRIPT` below) check the session is still
 *      alive and, only if so, mint a fresh refresh token bound to the
 *      SAME session id and update its `lastUsedAt`/`ip`/`userAgent` in
 *      place — rotation never creates a new session row. If the session
 *      was concurrently revoked, nothing is written and the caller gets
 *      401 — the old token was already single-use consumed in step 1, so
 *      there is no live token left after a revoked session hits this path.
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
 * Atomicity (closing a revoke-vs-rotate race): revoking a session and
 * committing a rotation each touch the session record + index together,
 * so both are implemented as single Redis Lua scripts (`REVOKE_SCRIPT`,
 * `COMMIT_SCRIPT`) — Redis executes a whole script as one atomic step,
 * so no other command (including the other script) can interleave
 * mid-way. Without this, a revoke reading a since-rotated refresh key
 * (or a rotate writing a fresh session record after a revoke already
 * deleted it) could let a "revoked" session's token quietly come back to
 * life. See each script's inline comment for the exact invariant it
 * enforces.
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

  /**
   * Atomically revoke one session. KEYS = [sessionKey, indexKey],
   * ARGV = [sessionId].
   *
   * Reads the session record, deletes its CURRENT backing refresh token
   * (whatever it is at the instant this script runs — not a value read
   * by the caller beforehand), the session record itself, and the index
   * entry, all as one atomic step. This is what closes the race with
   * `COMMIT_SCRIPT`: there is no window between "read the refresh key"
   * and "delete it" during which a concurrent rotation could swap in a
   * fresh token that this revoke would then miss.
   *
   * Returns 1 if a session was found and revoked, 0 if there was nothing
   * to revoke (still clears a stale index entry either way).
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
   * Atomically commit a (re)mint. KEYS = [newRefreshKey, indexKey,
   * sessionKey], ARGV = [requireExisting ('0'|'1'), sessionId,
   * tokenPayloadJson, ttlSeconds, sessionRecordJson].
   *
   * When `requireExisting` is `'1'` (rotation), first checks the session
   * is still a member of the user's index; if it is not (revoked
   * concurrently, by `REVOKE_SCRIPT` above, between this rotate's
   * initial GETDEL and this commit), aborts WITHOUT writing the new
   * refresh token or session record — the guard and the write happen in
   * the same atomic step, so there is no secondary window between the
   * check and the write for a revoke to sneak into. When `false`
   * (fresh login), always writes — a brand-new session id cannot
   * already be revoked.
   *
   * Returns 1 on a successful write, 0 when the guard rejected it.
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

  /**
   * Issue a brand-new refresh token bound to `userId`, and create the
   * session record it belongs to. Used by login/bootstrap.
   */
  async mint(userId: string, meta: SessionMeta): Promise<MintedRefreshToken> {
    const sessionId = randomUUID();
    // requireExisting=false: a freshly generated session id cannot
    // already be revoked, so this always succeeds.
    const minted = await this.commitMint(userId, sessionId, false, meta);
    if (!minted) {
      // Unreachable in practice (see above) — fail loudly rather than
      // silently return a bad shape if this invariant is ever violated.
      throw new Error('failed to mint a new session — this should never happen');
    }
    return { token: minted.token, expiresInSeconds: minted.expiresInSeconds, sessionId };
  }

  /**
   * Trade an unused refresh token for a new one, bound to the SAME
   * session id. Throws UnauthorizedException for unknown /
   * already-rotated / expired tokens, OR for a session that was
   * concurrently revoked between the GETDEL below and the atomic
   * commit — closing the SEC-RACE window where a rotate-in-flight could
   * otherwise resurrect a session `revokeSession`/`revokeOtherSessions`
   * just killed. `meta`, when supplied, refreshes the session's recorded
   * `ip`/`userAgent` — a refresh legitimately moving IP (mobile network
   * change) should be reflected, not frozen at login time.
   */
  async rotate(
    rawToken: string,
    meta?: Partial<SessionMeta>,
  ): Promise<{ userId: string; sessionId: string; refresh: MintedRefreshToken }> {
    const key = this.refreshKey(rawToken);
    // GETDEL is atomic in Redis 6.2+, so a concurrent rotation race
    // returns the value to exactly one caller; everyone else sees
    // null and is rejected. The old token is single-use consumed here
    // regardless of what happens next — if the commit below is rejected
    // (session revoked concurrently), there is no live token to roll
    // back to.
    const stored = await this.redis.client.getdel(key);
    if (!stored) {
      throw new UnauthorizedException('invalid refresh token');
    }
    const { userId, sessionId } = JSON.parse(stored) as StoredRefreshToken;
    // requireExisting=true: refuse to resurrect a session that was
    // revoked in the window between the GETDEL above and this call.
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
   * Best-effort logout — invalidate a specific refresh token and drop its
   * session record. Safe to call with an unknown token; resolves `null`
   * rather than throwing. Returns the resolved `userId` on a real revoke so
   * the caller (AuthService, R8-OBS-2) can attribute the `auth.logout`
   * audit row to a real actor instead of a NOT-NULL placeholder.
   */
  async revoke(rawToken: string): Promise<{ userId: string } | null> {
    const key = this.refreshKey(rawToken);
    const stored = await this.redis.client.getdel(key);
    if (!stored) return null;
    const { userId, sessionId } = JSON.parse(stored) as StoredRefreshToken;
    await this.forgetSession(userId, sessionId);
    return { userId };
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
   * Revoke exactly one session: atomically (see `REVOKE_SCRIPT`) deletes
   * its CURRENT backing refresh token (so a stolen token stops working
   * immediately, not just the display row) and its metadata. Returns
   * whether a session actually matched — the controller turns `false`
   * into a 404.
   */
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

  /**
   * Mint a fresh opaque token for `sessionId` and atomically commit it
   * together with the session record + index entry via `COMMIT_SCRIPT`.
   *
   * `requireExisting`:
   *   - `false` (login/bootstrap, brand-new `sessionId`) — always
   *     succeeds; there is nothing to check membership against yet.
   *   - `true` (rotation) — the commit atomically re-checks the session
   *     is still a member of the user's index before writing anything;
   *     returns `null` if it was revoked in the meantime (SEC-RACE guard).
   *
   * `createdAt`/`userAgent`/`ip` fall back to the EXISTING record (read
   * just before the atomic commit — staleness here only affects these
   * display fields, never the security-relevant membership check, which
   * is re-evaluated fresh inside the atomic script itself).
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
