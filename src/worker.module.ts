import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { appConfig } from './config/configuration';
import { envSchema } from './config/env.schema';
import { AppLoggerModule } from './infrastructure/logger/logger.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { EmailModule } from './modules/email/email.module';

/**
 * Composition root for the worker process. Mirrors AppModule but
 * deliberately omits the HTTP-side wiring (Fastify adapter, controller
 * pipeline, throttler, JwtAuthGuard, RolesGuard, AuditInterceptor):
 * workers do not serve HTTP. DrizzleModule and AuthModule are absent
 * because the email queue does not touch the database or JWTs — domain
 * processors that DO need them should add the imports they actually
 * use.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      validate: (raw) => envSchema.parse(raw),
    }),
    AppLoggerModule,
    RedisModule,
    QueueModule,
    EmailModule,
  ],
})
export class WorkerModule {}
