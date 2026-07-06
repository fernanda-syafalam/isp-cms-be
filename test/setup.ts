// NestJS dependency injection relies on emitDecoratorMetadata via reflect-metadata.
// Importing once here makes it available for every Vitest worker.
import 'reflect-metadata';

// Provide safe defaults so tests can validate env without needing a
// real .env file. Tests that override providers (e.g. a stubbed
// DrizzleService) still rely on envSchema.parse succeeding at module
// init time.
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app';
process.env.JWT_SECRET =
  process.env.JWT_SECRET ?? 'test-secret-must-be-at-least-32-characters-long';
// Silence pino during tests; flip to 'info' or 'debug' if a failure
// needs request-line diagnostics.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
// Effectively disable rate limiting during tests; limit cases are
// covered by unit tests, not by exhausting the real throttler.
process.env.THROTTLER_LIMIT = process.env.THROTTLER_LIMIT ?? '1000000';

// e2e specs boot the full AppModule, which wires BullMQ. In the unit+e2e CI
// job there is no Redis, so the BullMQ client's background connection retries
// emit ECONNREFUSED :6379 — benign noise the app already tolerates (the
// scheduler registration is wrapped in try/catch). Occasionally one of these
// surfaces as an unhandled rejection and fails an unrelated test file. Swallow
// ONLY that specific Redis-connection noise so real unhandled errors still fail.
function isRedisConnError(reason: unknown): boolean {
  if (reason == null || typeof reason !== 'object') {
    return typeof reason === 'string' && reason.includes('ECONNREFUSED') && reason.includes('6379');
  }
  const e = reason as { code?: string; port?: number; message?: string; errors?: unknown[] };
  if (e.code === 'ECONNREFUSED' && e.port === 6379) return true;
  if (
    typeof e.message === 'string' &&
    e.message.includes('ECONNREFUSED') &&
    e.message.includes('6379')
  )
    return true;
  // ioredis surfaces retries as an AggregateError of per-address connect errors.
  if (Array.isArray(e.errors)) return e.errors.some(isRedisConnError);
  return false;
}
process.on('unhandledRejection', (reason) => {
  if (isRedisConnError(reason)) return;
  throw reason;
});
