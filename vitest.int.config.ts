import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Integration test config — same SWC pipeline as vitest.config.ts but
 * scoped to *.int-spec.ts. These need Docker (Testcontainers) and are
 * slow, so they live behind `pnpm test:int` and are not part of the
 * default `pnpm test` run.
 */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { decoratorMetadata: true, legacyDecorator: true },
        target: 'es2022',
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.int-spec.ts'],
    // Integration tests share a Postgres container per file via
    // beforeAll; running them in parallel would race on the shared
    // database name unless we randomise it. Single thread keeps the
    // config readable.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
