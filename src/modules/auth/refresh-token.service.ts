import { createHash, randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { RedisService } from '../../infrastructure/redis/redis.service';

interface StoredRefreshToken {
  userId: string;
}

export interface MintedRefreshToken {
  token: string; // raw token returned to the client
  expiresInSeconds: number;
}

/**
 * Opaque refresh tokens with single-use rotation. The raw token is
 * never stored — Redis holds only sha256(rawToken) as the key, so a
 * leaked Redis dump cannot be used to log in.
 *
 * Rotation pattern (each `/v1/auth/refresh` call):
 *   1. Lookup current token by its hash and atomically delete it
 *      (Redis GETDEL — atomic so a concurrent retry cannot both
 *      succeed and produce two valid descendants).
 *   2. If lookup misses, the token is unknown OR already rotated.
 *      Respond 401 either way.
 *   3. Mint a fresh refresh token, return it to the client.
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
  private static readonly REDIS_KEY_PREFIX = 'refresh:';

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService<{ app: AppConfig }, true>,
  ) {}

  /**
   * Issue a brand-new refresh token bound to `userId`. Used by login.
   */
  async mint(userId: string): Promise<MintedRefreshToken> {
    const raw = randomBytes(32).toString('base64url');
    const key = this.redisKey(raw);
    const payload: StoredRefreshToken = { userId };
    const expiresInSeconds = this.ttlSeconds();
    await this.redis.client.set(key, JSON.stringify(payload), 'EX', expiresInSeconds);
    return { token: raw, expiresInSeconds };
  }

  /**
   * Trade an unused refresh token for a new one. Throws
   * UnauthorizedException for unknown / already-rotated / expired
   * tokens.
   */
  async rotate(rawToken: string): Promise<{ userId: string; refresh: MintedRefreshToken }> {
    const key = this.redisKey(rawToken);
    // GETDEL is atomic in Redis 6.2+, so a concurrent rotation race
    // returns the value to exactly one caller; everyone else sees
    // null and is rejected.
    const stored = await this.redis.client.getdel(key);
    if (!stored) {
      throw new UnauthorizedException('invalid refresh token');
    }
    const { userId } = JSON.parse(stored) as StoredRefreshToken;
    const refresh = await this.mint(userId);
    return { userId, refresh };
  }

  /**
   * Best-effort logout — invalidate a specific refresh token. Safe to
   * call with an unknown token; returns silently.
   */
  async revoke(rawToken: string): Promise<void> {
    await this.redis.client.del(this.redisKey(rawToken));
  }

  private redisKey(rawToken: string): string {
    const hash = createHash('sha256').update(rawToken).digest('hex');
    return `${RefreshTokenService.REDIS_KEY_PREFIX}${hash}`;
  }

  private ttlSeconds(): number {
    return this.config.get('app.jwt.refreshTokenTtlSeconds', { infer: true });
  }
}
