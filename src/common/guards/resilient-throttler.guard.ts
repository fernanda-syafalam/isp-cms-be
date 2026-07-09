import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerException, ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';

/**
 * Rate limiter that fails OPEN when its storage backend (Redis) is
 * unavailable.
 *
 * The default ThrottlerGuard lets a storage error propagate, which
 * AllExceptionsFilter turns into a 500. Because the guard runs on every
 * request, a Redis outage would then take the entire API down — a
 * rate limiter being unavailable must never do that.
 *
 * A genuine rate-limit hit (ThrottlerException / HTTP 429) is still a
 * real signal and is re-thrown unchanged. Only infrastructure failures
 * are swallowed, and each one is logged so the outage is visible.
 */
@Injectable()
export class ResilientThrottlerGuard extends ThrottlerGuard {
  private readonly resilientLogger = new Logger(ResilientThrottlerGuard.name);

  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    try {
      return await super.handleRequest(requestProps);
    } catch (err) {
      // A real 429 must still be enforced — propagate it untouched.
      if (err instanceof ThrottlerException) {
        throw err;
      }
      // Storage (Redis) failure: allow the request instead of 500-ing it.
      this.resilientLogger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'throttler storage unavailable — allowing request (fail-open)',
      );
      return true;
    }
  }
}
