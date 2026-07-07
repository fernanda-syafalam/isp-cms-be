import { Injectable } from '@nestjs/common';
import { RedisService } from '../../infrastructure/redis/redis.service';

/**
 * Per-user brute-force lockout for TOTP verification (F1). Backed by
 * Redis rather than a `user_security` column: the counter is purely
 * ephemeral (it must self-expire, and nothing outside this service ever
 * reads it), so a TTL key is a better fit than a DB column that would
 * need its own expiry housekeeping and a write on every failed attempt
 * on the hot login path. This mirrors the existing precedent in this
 * module for ephemeral per-user security state —
 * `RefreshTokenService` already stores opaque refresh tokens the same
 * way (`RedisService.client`, `EX` TTL, one key per subject).
 *
 * Policy: 5 consecutive failed verifications lock the account out of
 * further TOTP checks for 15 minutes; a successful verification clears
 * the counter immediately. The lockout key's TTL is set once, on the
 * *first* failure of a run — repeated failures while already locked
 * don't push the window further out, so a flood of attempts during
 * lockout still expires 15 minutes after the run started, not later.
 */
@Injectable()
export class TotpLockoutService {
  private static readonly REDIS_KEY_PREFIX = 'totp:lockout:';
  static readonly MAX_ATTEMPTS = 5;
  static readonly LOCKOUT_TTL_SECONDS = 15 * 60;

  constructor(private readonly redis: RedisService) {}

  /** True when this user has hit the failure threshold and is still within the lockout window. */
  async isLocked(userId: string): Promise<boolean> {
    const raw = await this.redis.client.get(this.key(userId));
    return raw !== null && Number(raw) >= TotpLockoutService.MAX_ATTEMPTS;
  }

  /** Record one failed verification. Starts the 15-minute window on the first failure. */
  async recordFailure(userId: string): Promise<void> {
    const key = this.key(userId);
    const count = await this.redis.client.incr(key);
    if (count === 1) {
      await this.redis.client.expire(key, TotpLockoutService.LOCKOUT_TTL_SECONDS);
    }
  }

  /** Clear the counter — called after any successful verification. */
  async recordSuccess(userId: string): Promise<void> {
    await this.redis.client.del(this.key(userId));
  }

  private key(userId: string): string {
    return `${TotpLockoutService.REDIS_KEY_PREFIX}${userId}`;
  }
}
