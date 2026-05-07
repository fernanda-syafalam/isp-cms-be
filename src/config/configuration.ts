import { registerAs } from '@nestjs/config';
import { envSchema } from './env.schema';

/**
 * Typed config object loaded into ConfigModule. Parses (does not just
 * cast) `process.env` here so coerced values (number, enum) reach the
 * config — see ADR-0002 / v2 Best Practices doc, Pilar 1 for the
 * "parse, don't cast" rationale.
 */
export const appConfig = registerAs('app', () => {
  const env = envSchema.parse(process.env);
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    database: {
      url: env.DATABASE_URL,
      poolSize: env.DATABASE_POOL_SIZE,
    },
    redis: {
      url: env.REDIS_URL,
    },
    throttler: {
      ttlMs: env.THROTTLER_TTL_MS,
      limit: env.THROTTLER_LIMIT,
    },
    jwt: {
      secret: env.JWT_SECRET,
      expiresIn: env.JWT_EXPIRES_IN,
    },
    logLevel: env.LOG_LEVEL,
  } as const;
});

export type AppConfig = ReturnType<typeof appConfig>;
