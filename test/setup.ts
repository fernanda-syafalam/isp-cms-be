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
