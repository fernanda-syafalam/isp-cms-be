import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { AppConfig } from '../../config/configuration';

/** Strip the password from a redis:// URL so it is safe to log. */
function redactRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return '<unparseable redis url>';
  }
}

/**
 * Wraps a single shared ioredis client. Repositories and infra
 * adapters (throttler storage, future cache, BullMQ connection) inject
 * this service instead of new-ing their own client — one TCP
 * connection per pod is enough for typical NestJS workloads.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  // client is assigned in onModuleInit before any consumer reads it.
  public client!: Redis;

  constructor(private readonly config: ConfigService<{ app: AppConfig }, true>) {}

  async onModuleInit(): Promise<void> {
    const url = this.config.get('app.redis.url', { infer: true });
    // Log the target host (password redacted) so a mis-injected env var
    // is obvious in the deploy logs instead of surfacing as a silent
    // fall-through to localhost.
    this.logger.log(`connecting to redis at ${redactRedisUrl(url)}`);

    this.client = new Redis(url, {
      // Lazy connect lets infra constructors register the client before
      // the network round-trip happens.
      lazyConnect: true,
      // Fail fast instead of hanging a request for tens of seconds when
      // Redis is unreachable: bound the connect, cap retries per command,
      // and reject commands immediately rather than queueing them offline.
      connectTimeout: 5_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 500, 5_000),
    });

    // Without a handler, ioredis re-emits connection failures as an
    // 'Unhandled error event' — noisy and, in some Node versions, fatal.
    this.client.on('error', (err) => {
      this.logger.warn({ err: err.message }, 'redis client error');
    });

    try {
      await this.client.connect();
      await this.client.ping();
      this.logger.log('redis client connected');
    } catch (err) {
      // Degrade gracefully: a Redis outage at boot must not crash-loop
      // the whole API. Rate limiting fails open (ResilientThrottlerGuard)
      // and /healthz stays up (SkipThrottle); auth flows that truly need
      // Redis fail fast with a clear error instead of hanging.
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'redis unavailable at startup — continuing in degraded mode',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => {
      // quit can race with in-flight commands during shutdown — fall
      // back to disconnect so the pool actually closes.
      this.client?.disconnect();
    });
    this.logger.log('redis client closed');
  }

  /**
   * Lightweight readiness probe — returns true when the server
   * responds to PING within ioredis' default timeout. HealthController
   * uses this from /readyz.
   */
  async ping(): Promise<boolean> {
    try {
      const reply = await this.client.ping();
      return reply === 'PONG';
    } catch (err) {
      this.logger.warn({ err }, 'redis ping failed');
      return false;
    }
  }
}
