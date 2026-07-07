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
 * Mirrors `TotpLockoutService`'s Redis-per-user pattern: one key per
 * user, self-expiring TTL, nothing outside this service ever reads it —
 * so a Redis-backed TTL key is a better fit than a DB column here too.
 *
 * TTL is comfortably longer than the ±1 step window so the key doesn't
 * expire mid-flow, but short enough that it doesn't linger: once it does
 * expire there is nothing meaningful to "forget" anyway, because a step
 * that old would already be outside otplib's own verification window and
 * rejected as an invalid code before the replay check ever runs.
 */
@Injectable()
export class TotpReplayGuardService {
  private static readonly REDIS_KEY_PREFIX = 'totp:replay:';
  static readonly TTL_SECONDS = 5 * 60;

  constructor(private readonly redis: RedisService) {}

  /** The last TOTP step accepted for this user, or `null` if none (or expired). */
  async getLastAcceptedStep(userId: string): Promise<number | null> {
    const raw = await this.redis.client.get(this.key(userId));
    return raw === null ? null : Number(raw);
  }

  /** Record `step` as accepted for this user, (re)starting the self-expiry TTL. */
  async recordAcceptedStep(userId: string, step: number): Promise<void> {
    const key = this.key(userId);
    await this.redis.client.set(key, String(step));
    await this.redis.client.expire(key, TotpReplayGuardService.TTL_SECONDS);
  }

  private key(userId: string): string {
    return `${TotpReplayGuardService.REDIS_KEY_PREFIX}${userId}`;
  }
}
