import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { appConfig } from './config/configuration';
import { envSchema } from './config/env.schema';
import { DrizzleModule } from './infrastructure/database/drizzle.module';
import { AppLoggerModule } from './infrastructure/logger/logger.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { AuditModule } from './modules/audit/audit.module';
import { EmailWorkerModule } from './modules/email/email-worker.module';
import { NotificationsWorkerModule } from './modules/notifications/notifications-worker.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';

/**
 * Composition root for the worker process. Mirrors AppModule but
 * deliberately omits the HTTP-side wiring (Fastify adapter, controller
 * pipeline, throttler, JwtAuthGuard, RolesGuard, AuditInterceptor):
 * workers do not serve HTTP. AuthModule is absent because nothing here
 * needs JWT issuance/verification.
 *
 * Invariant (R10-OPS-1): this is the ONLY composition root that may import
 * a BullMQ processor. It holds every consumer that exists in the system —
 * EmailProcessor (via EmailWorkerModule), NotificationsProcessor (via
 * NotificationsWorkerModule), and SchedulerProcessor (via SchedulerModule,
 * which also brings InvoicesModule + TicketsModule — the domain services
 * SchedulerProcessor dispatches each tick to). DrizzleModule and
 * AuditModule are imported here (they were previously omitted because the
 * email queue alone touches neither) because the scheduler and
 * notifications consumers DO read/write through repositories, and
 * PaymentIntentsService (invoked by SchedulerProcessor's
 * `payment-intents.expire-sweep` tick, via InvoicesModule) injects
 * AuditRepository directly. Both are @Global(), so importing each once
 * here makes DrizzleService/AuditRepository available to every domain
 * module the two *WorkerModule/SchedulerModule branches pull in — this is
 * exactly the gap test/worker-isolation.e2e-spec.ts caught (a DI
 * resolution failure, not a missing-import typo) when SchedulerModule's
 * dependency chain was first wired into this composition root.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      validate: (raw) => envSchema.parse(raw),
    }),
    AppLoggerModule,
    DrizzleModule,
    AuditModule,
    RedisModule,
    QueueModule,
    EmailWorkerModule,
    NotificationsWorkerModule,
    SchedulerModule,
  ],
})
export class WorkerModule {}
