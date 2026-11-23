import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { ResilientThrottlerGuard } from './common/guards/resilient-throttler.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { type AppConfig, appConfig } from './config/configuration';
import { envSchema } from './config/env.schema';
import { DrizzleModule } from './infrastructure/database/drizzle.module';
import { AppLoggerModule } from './infrastructure/logger/logger.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { CustomersModule } from './modules/customers/customers.module';
import { HealthModule } from './modules/health/health.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PlansModule } from './modules/plans/plans.module';
import { RouterResourcesModule } from './modules/router-resources/router-resources.module';
import { RoutersModule } from './modules/routers/routers.module';
import { SecurityModule } from './modules/security/security.module';
import { SettingsModule } from './modules/settings/settings.module';
import { SetupModule } from './modules/setup/setup.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { UsersModule } from './modules/users/users.module';
import { WorkOrdersModule } from './modules/work-orders/work-orders.module';

/**
 * Composition root. Should only import other modules and wire global
 * providers — no controllers or domain providers of its own. See v2
 * Best Practices doc, Pilar 1.
 *
 * Invariant (R10-OPS-1): the API process registers ZERO BullMQ
 * processors/WorkerHosts, so background queue load never steals the API's
 * tuned CPU/mem budget. NotificationsModule below is the PRODUCER side
 * only (queue registration + *Service.enqueue); its consumer
 * (NotificationsProcessor) lives in NotificationsWorkerModule, imported
 * only by WorkerModule. EmailModule and its consumer are unregistered
 * for the MVP (source kept on disk), as are ResellersModule and SlaCreditsModule
 * (commission/payout and the SLA-credit screens are v1.1; SlaCreditsRepository is still
 * provided to InvoicesModule so billing absorbs proration credits). SchedulerModule (SchedulerProcessor + the scheduler's own
 * repeatable-job registration) is entirely worker-side and intentionally
 * absent from this import list. See test/worker-isolation.e2e-spec.ts,
 * which fails if a processor is reintroduced here.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      // Fails startup if any env var is invalid, instead of letting the
      // app boot with bad config and crash later.
      validate: (raw) => envSchema.parse(raw),
    }),
    AppLoggerModule,
    DrizzleModule,
    RedisModule,
    // Rate limit per IP, backed by Redis so the limit is consistent
    // across pods. In-memory storage resets per replica and is useless
    // in K8s — see Pilar 2.
    //
    // Tests use the in-memory default to stay offline; the real Redis
    // wiring is exercised by hand or in a future integration suite
    // when the throttler logic itself needs coverage.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<{ app: AppConfig }, true>) => {
        const throttlers = [
          {
            ttl: config.get('app.throttler.ttlMs', { infer: true }),
            limit: config.get('app.throttler.limit', { infer: true }),
          },
        ];
        if (config.get('app.nodeEnv', { infer: true }) === 'test') {
          return { throttlers };
        }
        // Pass the URL, NOT RedisService.client: this factory runs during DI,
        // before RedisService.onModuleInit assigns `client`, so `client` is
        // undefined here. ThrottlerStorageRedisService(undefined) falls to its
        // `new Redis(undefined)` branch → 127.0.0.1:6379, which failed forever
        // (rate limiting silently dead + [ioredis] ECONNREFUSED spam). Given a
        // string it does `new Redis(url)` and reaches the configured Redis.
        return {
          throttlers,
          storage: new ThrottlerStorageRedisService(config.get('app.redis.url', { infer: true })),
        };
      },
    }),
    QueueModule,
    AnalyticsModule,
    AuditModule,
    AuthModule,
    CustomersModule,
    HealthModule,
    InventoryModule,
    InvoicesModule,
    NotificationsModule,
    PlansModule,
    RouterResourcesModule,
    RoutersModule,
    SecurityModule,
    SettingsModule,
    SetupModule,
    TicketsModule,
    UsersModule,
    WorkOrdersModule,
  ],
  providers: [
    // Global error filter -> RFC 7807 application/problem+json. Wired
    // through APP_FILTER (instead of useGlobalFilters in main.ts) so
    // PinoLogger gets injected properly.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Default-deny: every endpoint requires a JWT unless `@Public()` is
    // applied. Pilar 4.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Per-IP rate limit. Runs after JwtAuthGuard so unauthenticated
    // traffic still counts against the same bucket. Uses the resilient
    // variant so a Redis (storage) outage fails open instead of 500-ing
    // every request.
    { provide: APP_GUARD, useClass: ResilientThrottlerGuard },
    // Coarse RBAC. No-op unless a handler opts in with @Roles(...).
    // Resource ownership ("only owner of order X") still belongs in
    // the service, not here. Pilar 4.
    { provide: APP_GUARD, useClass: RolesGuard },
    // Structured audit log for handlers annotated with @Audit('...').
    // Pass-through for everything else. Registered BEFORE
    // ZodSerializerInterceptor so it is the OUTER layer: NestJS composes
    // multiple APP_INTERCEPTOR providers like onion layers, in
    // registration order (first = outermost, closest to the client;
    // last = innermost, closest to the handler). With Audit outer and
    // Serializer inner, a handler's raw return value is validated/
    // stripped by the serializer FIRST, and only that already-safe
    // (or, on a schema mismatch, the resulting error) reaches Audit's
    // tap()/error() — so an audited endpoint's audit outcome
    // ('success'/'failure') reflects what actually left the process,
    // including a response-serialization failure. The reverse order
    // would let Audit log 'success' for a request that then 500s during
    // serialization.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    // Enforces every `@ZodSerializerDto(...)` annotation (100+ handlers)
    // at runtime: parses the handler's return value against the
    // declared response schema, stripping any field the schema doesn't
    // declare (e.g. `passwordHash` on users, encrypted TOTP secrets) and
    // throwing a ZodSerializationException — surfaced as a 500 by
    // AllExceptionsFilter (which logs the Zod issue server-side) — if
    // the runtime value doesn't match the schema's shape (e.g. a raw
    // `Date` where the schema declares `z.iso.datetime()`). Previously
    // dead metadata: `@ZodSerializerDto` was applied everywhere but
    // never enforced because this provider was missing.
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
    // ZodValidationPipe is registered globally so that any DTO created
    // with `createZodDto()` is validated automatically. Non-zod DTOs
    // pass through unchanged.
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
