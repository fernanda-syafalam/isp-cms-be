import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { appConfig } from './config/configuration';
import { envSchema } from './config/env.schema';
import { DrizzleModule } from './infrastructure/database/drizzle.module';
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
    DrizzleModule,
    HealthModule,
    UsersModule,
  ],
  providers: [
    // ZodValidationPipe is registered globally so that any DTO created
    // with `createZodDto()` is validated automatically. Non-zod DTOs
    // pass through unchanged.
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
