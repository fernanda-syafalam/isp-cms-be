import { Injectable } from '@nestjs/common';
import { RedisService } from '../../infrastructure/redis/redis.service';

/**
 * F5: per-user TOTP replay guard. otplib's `window: 1` accepts a code up
 * to one step (30s) in the past or future, which makes any valid code
 * reusable for up to ~90s. This service tracks the last TOTP step
 * (counter) accepted for a user so `SecurityService` can reject that same
 * step — or any older one — even though otplib itself would still call it
 * valid. Only a strictly later step is accepted afterwards.
 *
 * Mirrors `TotpLockoutService`'s Redis-per-user pattern (one key per
 * user, self-expiring TTL, nothing outside this service ever reads it),
 * and mirrors `RefreshTokenService`'s Lua-script atomicity pattern
 * (`REVOKE_SCRIPT`/`COMMIT_SCRIPT`): the "read the last accepted step,
 * reject if the new one isn't strictly greater, else record it" sequence
 * is a single Redis Lua `EVAL`, not separate GET-then-SET round trips.
 * Without that, two concurrent requests bearing the SAME still-valid code
 * could both read "no step recorded yet" (or the same last step) before
 * either had written, and both would be accepted — a captured code used
 * twice. Redis executes a whole script as one atomic step, closing that
 * window.
 */
@Injectable()
export class TotpReplayGuardService {
  private static readonly REDIS_KEY_PREFIX = 'totp:replay:';
  static readonly TTL_SECONDS = 5 * 60;

  /**
   * Atomic compare-and-set. KEYS = [key], ARGV = [step, ttlSeconds].
   *
   * Rejects (returns 0) when a step already recorded for this key is
   * greater than or equal to `step` — the replay condition (same step,
   * or an older one). Otherwise records `step` with a fresh TTL, all in
   * the same atomic step, and accepts (returns 1). The self-expiring TTL
   * is set via `SET key step EX ttl` here (one command), not a separate
   * `SET` + `EXPIRE`.
   */
  private static readonly ACCEPT_STEP_SCRIPT = `
local last = redis.call('GET', KEYS[1])
if last and tonumber(last) >= tonumber(ARGV[1]) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

  constructor(private readonly redis: RedisService) {}

  /**
   * Attempt to accept `step` as the newest TOTP step used by this user.
   * Returns `true` when accepted (the step is now recorded as the last
   * accepted one), `false` when it is a replay — a step already
   * accepted, or older than one already accepted, for this user.
   */
  async acceptStep(userId: string, step: number): Promise<boolean> {
    const result = await this.redis.client.eval(
      TotpReplayGuardService.ACCEPT_STEP_SCRIPT,
      1,
      this.key(userId),
      String(step),
      String(TotpReplayGuardService.TTL_SECONDS),
    );
    return result === 1;
  }

  private key(userId: string): string {
    return `${TotpReplayGuardService.REDIS_KEY_PREFIX}${userId}`;
  }
}
