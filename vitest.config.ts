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
        '**/main.ts',
        '**/*.module.ts',
        'dist/**',
        'coverage/**',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
