import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { appConfig } from './config/configuration';
import { envSchema } from './config/env.schema';
import { DrizzleModule } from './infrastructure/database/drizzle.module';
import { AppLoggerModule } from './infrastructure/logger/logger.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { UsersModule } from './modules/users/users.module';

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
    AuthModule,
    HealthModule,
    UsersModule,
  ],
  providers: [
    // Global error filter -> RFC 7807 application/problem+json. Wired
    // through APP_FILTER (instead of useGlobalFilters in main.ts) so
    // PinoLogger gets injected properly.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Default-deny: every endpoint requires a JWT unless `@Public()` is
    // applied. Pilar 4.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // ZodValidationPipe is registered globally so that any DTO created
    // with `createZodDto()` is validated automatically. Non-zod DTOs
    // pass through unchanged.
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
