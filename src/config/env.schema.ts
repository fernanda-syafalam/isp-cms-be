import { z } from 'zod';

const TWOFA_ENC_KEY_BYTES = 32;

/** `TWOFA_ENC_KEY` must decode (base64) to exactly 32 raw bytes — an AES-256 key. */
function isValidTwoFaEncKey(value: string): boolean {
  try {
    // Buffer.from(..., 'base64') never throws on invalid input, it just
    // decodes what it can — the length check is what actually catches a
    // malformed/short/placeholder value.
    return Buffer.from(value, 'base64').length === TWOFA_ENC_KEY_BYTES;
  } catch {
    return false;
  }
}

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
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),

    DATABASE_URL: z.string().min(1),
    DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),

    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

    THROTTLER_TTL_MS: z.coerce.number().int().positive().default(60_000),
    THROTTLER_LIMIT: z.coerce.number().int().positive().default(100),

    // Consumed at bootstrap (main.ts) BEFORE the DI container / ConfigService
    // exists, so main.ts reads process.env.TRUST_PROXY directly — this entry
    // documents + validates it. Controls Fastify `trustProxy`: how many proxy
    // hops to trust when deriving the client IP the per-IP throttler keys on.
    // Default 1 (a single ingress, e.g. Dokploy/Traefik) makes the throttle's
    // X-Forwarded-For unspoofable — Fastify uses the IP the trusted proxy
    // recorded, not an attacker-supplied header — so login/2FA rate limits
    // can't be bypassed (R5-SEC-1). Values: 'false'/0 = no proxy (socket IP),
    // N = N chained proxies (e.g. Cloudflare in front of Traefik), or a
    // CIDR/comma-separated IP list to trust only those hops. Constrained so an
    // invalid value fails env validation with a clear message rather than
    // surfacing as a proxy-addr TypeError deep in bootstrap. NOTE:
    // `TRUST_PROXY=true` trusts the WHOLE X-Forwarded-For chain and reinstates
    // the R5-SEC-1 spoof bypass — prefer a hop count.
    TRUST_PROXY: z
      .string()
      .regex(
        /^(true|false|\d+|[\d.,:/\s]+)$/,
        'TRUST_PROXY must be true/false, a hop count, or a CIDR/IP list',
      )
      .optional(),

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

    // F2: AES-256-GCM key encrypting the TOTP secret at rest (see
    // `TotpSecretCipherService`). Must be exactly 32 raw bytes, base64
    // encoded — generate with `openssl rand -base64 32`. Deliberately a
    // separate secret from `JWT_SECRET`/`DATABASE_URL`: rotating it never
    // requires touching the DB connection or re-issuing JWTs, and a DB-only
    // dump does not also leak it. Always required (like `JWT_SECRET`
    // above) — dev/test supply their own fixed real value (`.env`,
    // `test/setup.ts`) rather than the schema special-casing `NODE_ENV`.
    TWOFA_ENC_KEY: z.string().min(1).refine(isValidTwoFaEncKey, {
      message: 'TWOFA_ENC_KEY must be a base64-encoded 32-byte (256-bit) key',
    }),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

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

    // Network enforcement (P2.5, ADR-0008). 'simulation' keeps the DB flag as
    // the only effect (dev/test/default); 'live' also pushes enable/disable to
    // the real RouterOS device over the API. The API password is shared across
    // managed routers (single-operator model) and never stored in the DB.
    ROUTEROS_MODE: z.enum(['simulation', 'live']).default('simulation'),
    ROUTEROS_API_PASSWORD: z.string().optional(),

    // WhatsApp delivery transport (ADR-0017). 'log' (default) keeps the
    // pre-existing dev/demo behavior — only the notification_log row is
    // written, no external call. 'wa' sends through a Fonnte/Wablas-class
    // WhatsApp HTTP gateway. See src/modules/notifications/transports/.
    NOTIFICATION_MODE: z.enum(['log', 'wa']).default('log'),
    WA_API_URL: z.string().url().optional(),
    WA_API_TOKEN: z.string().optional(),

    // Payment gateway (ADR-0016). 'simulation' (default) keeps the existing
    // dev/demo VA/QR mock behavior with no real money movement; 'live' charges
    // through Tripay and settles only via its signed webhook (SEC-H1: never
    // customer-callable). See src/modules/invoices/payment-gateway/.
    PAYMENT_MODE: z.enum(['simulation', 'live']).default('simulation'),
    TRIPAY_API_KEY: z.string().optional(),
    TRIPAY_PRIVATE_KEY: z.string().optional(),
    TRIPAY_MERCHANT_CODE: z.string().optional(),
    TRIPAY_BASE_URL: z.string().url().optional(),
  })
  .superRefine((env, ctx) => {
    // Fail FAST at startup if NOTIFICATION_MODE=wa is armed without the
    // gateway credentials, not silently no-op on the first real dunning
    // cycle in production.
    if (env.NOTIFICATION_MODE === 'wa') {
      const required = [
        ['WA_API_URL', env.WA_API_URL],
        ['WA_API_TOKEN', env.WA_API_TOKEN],
      ] as const;
      for (const [key, value] of required) {
        if (!value) {
          ctx.addIssue({
            code: 'custom',
            message: `${key} is required when NOTIFICATION_MODE=wa`,
            path: [key],
          });
        }
      }
    }
    // Money-critical: PAYMENT_MODE=live must fail FAST at startup if a Tripay
    // secret is missing, not silently no-op on the first real charge/webhook.
    if (env.PAYMENT_MODE === 'live') {
      const required = [
        ['TRIPAY_API_KEY', env.TRIPAY_API_KEY],
        ['TRIPAY_PRIVATE_KEY', env.TRIPAY_PRIVATE_KEY],
        ['TRIPAY_MERCHANT_CODE', env.TRIPAY_MERCHANT_CODE],
        ['TRIPAY_BASE_URL', env.TRIPAY_BASE_URL],
      ] as const;
      for (const [key, value] of required) {
        if (!value) {
          ctx.addIssue({
            code: 'custom',
            message: `${key} is required when PAYMENT_MODE=live`,
            path: [key],
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;
