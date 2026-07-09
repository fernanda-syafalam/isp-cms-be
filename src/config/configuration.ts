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
      refreshTokenTtlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
    },
    // Also reused by RouterCredentialCipherService for per-router RouterOS
    // API password encryption at rest (SEC-M1) — one app "encrypt a secret
    // at rest" key for v1 rather than a second env secret; see that
    // service's doc comment for the tradeoff.
    twoFactor: {
      encKey: env.TWOFA_ENC_KEY,
    },
    logLevel: env.LOG_LEVEL,
    cors: {
      // Split here so downstream code gets a ready-to-use string array.
      origins: env.CORS_ORIGINS.split(',').map((o) => o.trim()),
    },
    cookie: {
      secure: env.COOKIE_SECURE,
      domain: env.COOKIE_DOMAIN,
      sameSite: env.COOKIE_SAMESITE,
    },
    routeros: {
      mode: env.ROUTEROS_MODE,
      apiPassword: env.ROUTEROS_API_PASSWORD,
    },
    payment: {
      mode: env.PAYMENT_MODE,
      tripay: {
        apiKey: env.TRIPAY_API_KEY,
        privateKey: env.TRIPAY_PRIVATE_KEY,
        merchantCode: env.TRIPAY_MERCHANT_CODE,
        baseUrl: env.TRIPAY_BASE_URL,
      },
    },
  } as const;
});

export type AppConfig = ReturnType<typeof appConfig>;
