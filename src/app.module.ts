import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { type AppConfig, appConfig } from './config/configuration';
import { envSchema } from './config/env.schema';
import { DrizzleModule } from './infrastructure/database/drizzle.module';
import { AppLoggerModule } from './infrastructure/logger/logger.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { RedisService } from './infrastructure/redis/redis.service';
import { AccountingModule } from './modules/accounting/accounting.module';
import { AcsModule } from './modules/acs/acs.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AnnouncementsModule } from './modules/announcements/announcements.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { BranchesModule } from './modules/branches/branches.module';
import { ContractsModule } from './modules/contracts/contracts.module';
import { CoverageModule } from './modules/coverage/coverage.module';
import { CustomersModule } from './modules/customers/customers.module';
import { DevicesModule } from './modules/devices/devices.module';
import { EmailModule } from './modules/email/email.module';
import { HealthModule } from './modules/health/health.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { LeadsModule } from './modules/leads/leads.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OdpModule } from './modules/odp/odp.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { PlansModule } from './modules/plans/plans.module';
import { PortalModule } from './modules/portal/portal.module';
import { ResellersModule } from './modules/resellers/resellers.module';
import { RouterResourcesModule } from './modules/router-resources/router-resources.module';
import { RoutersModule } from './modules/routers/routers.module';
import { SatisfactionModule } from './modules/satisfaction/satisfaction.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { SecurityModule } from './modules/security/security.module';
import { SettingsModule } from './modules/settings/settings.module';
import { SetupModule } from './modules/setup/setup.module';
import { SlaCreditsModule } from './modules/sla-credits/sla-credits.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { TopologyModule } from './modules/topology/topology.module';
import { UsageModule } from './modules/usage/usage.module';
import { UsersModule } from './modules/users/users.module';
import { VouchersModule } from './modules/vouchers/vouchers.module';
import { WorkOrdersModule } from './modules/work-orders/work-orders.module';

/**
 * Composition root. Should only import other modules and wire global
 * providers — no controllers or domain providers of its own. See v2
 * Best Practices doc, Pilar 1.
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
      inject: [ConfigService, RedisService],
      useFactory: (config: ConfigService<{ app: AppConfig }, true>, redis: RedisService) => {
        const throttlers = [
          {
            ttl: config.get('app.throttler.ttlMs', { infer: true }),
            limit: config.get('app.throttler.limit', { infer: true }),
          },
        ];
        if (config.get('app.nodeEnv', { infer: true }) === 'test') {
          return { throttlers };
        }
        return {
          throttlers,
          storage: new ThrottlerStorageRedisService(redis.client),
        };
      },
    }),
    QueueModule,
    AccountingModule,
    AcsModule,
    AnalyticsModule,
    AnnouncementsModule,
    AuditModule,
    AuthModule,
    BranchesModule,
    ContractsModule,
    CoverageModule,
    CustomersModule,
    DevicesModule,
    EmailModule,
    HealthModule,
    InventoryModule,
    InvoicesModule,
    LeadsModule,
    MonitoringModule,
    NotificationsModule,
    OdpModule,
    OnboardingModule,
    PlansModule,
    PortalModule,
    ResellersModule,
    RouterResourcesModule,
    RoutersModule,
    SatisfactionModule,
    SchedulerModule,
    SecurityModule,
    SettingsModule,
    SetupModule,
    SlaCreditsModule,
    TicketsModule,
    TopologyModule,
    UsageModule,
    UsersModule,
    VouchersModule,
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
    // Per-IP rate limit. ThrottlerGuard runs after JwtAuthGuard so
    // unauthenticated traffic still counts against the same bucket.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
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
