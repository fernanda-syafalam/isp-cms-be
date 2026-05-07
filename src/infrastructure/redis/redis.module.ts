import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Global because the throttler, future cache, and any BullMQ wiring
 * all need a Redis client. Per Pilar 1, @Global() is reserved for
 * infrastructure modules.
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
