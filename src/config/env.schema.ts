import { z } from 'zod';

/**
 * Environment variable schema. Single source of truth — every env var
 * the app reads must be declared here. Validation runs at startup so
 * the process fails fast on a misconfiguration instead of crashing on
 * the first request.
 *
 * Add new variables here as features land:
 *   DATABASE_URL  -> when Drizzle / pg is wired up
 *   REDIS_URL     -> when Redis / BullMQ is wired up
 *   JWT_SECRET    -> when auth is wired up
 *   LOG_LEVEL     -> when nestjs-pino is wired up
 *
 * See v2 Best Practices doc, Pilar 1 ("Konfigurasi dengan validasi
 * schema") for the broader pattern.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),

  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  THROTTLER_TTL_MS: z.coerce.number().int().positive().default(60_000),
  THROTTLER_LIMIT: z.coerce.number().int().positive().default(100),

  // 32+ char keeps brute-force out of reach. The schema rejects shorter
  // values so a placeholder secret never leaks into production.
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('15m'),
  // Refresh tokens are opaque (not JWTs) and stored hashed in Redis;
  // the value here controls Redis TTL.
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // CORS — comma-separated list of allowed origins for the browser SPA.
  // No wildcard is allowed when credentials:true (ADR-0002 / cookie model).
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  // Cookie settings for the httpOnly refresh_token cookie.
  COOKIE_SECURE: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .pipe(z.boolean())
    .default(false),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  // OpenTelemetry. Endpoint absent -> SDK is a no-op (instrumentation
  // still loads but spans / metrics are dropped) so engineers can run
  // pnpm dev without a local collector.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().min(1).default('isp-cms-be'),
  SERVICE_VERSION: z.string().default('0.0.0'),
});

export type Env = z.infer<typeof envSchema>;
