import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';

/**
 * Root BullMQ wiring (queue + worker share the same defaults). Pilar 7
 * defaults that have caused production fires when omitted:
 *
 * - `removeOnComplete` / `removeOnFail` capped — without this Redis
 *   slowly fills with old jobs over months.
 * - `attempts` + exponential backoff — every job is retry-friendly by
 *   default; opt out per-job if a fast-fail is desired.
 *
 * Per-queue overrides go in each domain's `BullModule.registerQueue`
 * call (see `email.module.ts`).
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<{ app: AppConfig }, true>) => ({
        connection: { url: config.get('app.redis.url', { infer: true }) },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: { count: 1_000 },
          removeOnFail: { count: 5_000 },
        },
      }),
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
