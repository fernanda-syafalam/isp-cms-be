import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ZodValidationPipe } from 'nestjs-zod';
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
import { AuthModule } from './modules/auth/auth.module';
import { ContractsModule } from './modules/contracts/contracts.module';
import { CustomersModule } from './modules/customers/customers.module';
import { EmailModule } from './modules/email/email.module';
import { HealthModule } from './modules/health/health.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { LeadsModule } from './modules/leads/leads.module';
import { PlansModule } from './modules/plans/plans.module';
import { ResellersModule } from './modules/resellers/resellers.module';
import { RoutersModule } from './modules/routers/routers.module';
import { SlaCreditsModule } from './modules/sla-credits/sla-credits.module';
import { TicketsModule } from './modules/tickets/tickets.module';
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
    AuthModule,
    ContractsModule,
    CustomersModule,
    EmailModule,
    HealthModule,
    InventoryModule,
    InvoicesModule,
    LeadsModule,
    PlansModule,
    ResellersModule,
    RoutersModule,
    SlaCreditsModule,
    TicketsModule,
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
    // Pass-through for everything else.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    // ZodValidationPipe is registered globally so that any DTO created
    // with `createZodDto()` is validated automatically. Non-zod DTOs
    // pass through unchanged.
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
