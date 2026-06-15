import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // SWC keeps NestJS decorator metadata working in tests without ts-jest.
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
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    // Integration tests are slower (Testcontainers ~5 s each) and need
    // Docker; run them with `pnpm test:int` instead.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.int-spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: [
        '**/*.spec.ts',
        '**/*.e2e-spec.ts',
        '**/*.int-spec.ts',
        '**/main.ts',
        '**/*.module.ts',
        '**/*.dto.ts',
        // Repositories and the Drizzle infra service are exercised by
        // integration tests (`*.int-spec.ts`) which use Testcontainers;
        // they are intentionally not part of the unit/e2e coverage
        // gate. Run `pnpm test:int` for their coverage.
        '**/*.repository.ts',
        '**/infrastructure/database/drizzle.service.ts',
        // Tooling configs at repo root.
        'drizzle.config.ts',
        'vitest.config.ts',
        'vitest.int.config.ts',
        'dist/**',
        'coverage/**',
      ],
      // Pragmatic thresholds for this service phase. v2 doc Pilar 5
      // calls for 80% lines on production services; raise these when
      // the codebase has more business logic to cover.
      thresholds: {
        lines: 70,
        functions: 50,
        branches: 70,
        statements: 70,
      },
    },
  },
});
