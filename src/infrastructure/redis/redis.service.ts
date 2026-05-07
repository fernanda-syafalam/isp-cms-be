import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { AppConfig } from '../../config/configuration';

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
    this.client = new Redis(this.config.get('app.redis.url', { infer: true }), {
      // Lazy connect lets infra constructors register the client before
      // the network round-trip happens; avoids bootstrap-time failures
      // from temporary Redis hiccups.
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      // ioredis defaults to retrying forever; cap to keep failed
      // requests from piling up.
    });

    await this.client.connect();
    await this.client.ping();
    this.logger.log('redis client connected');
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
