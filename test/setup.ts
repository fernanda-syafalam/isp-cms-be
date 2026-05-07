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
