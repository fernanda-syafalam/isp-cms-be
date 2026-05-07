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
});

export type Env = z.infer<typeof envSchema>;
