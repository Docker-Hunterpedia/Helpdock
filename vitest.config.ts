import { defineConfig } from 'vitest/config';

// Single root run: `pnpm test` executes every workspace project and reports one
// merged coverage number. `turbo run test --filter=…` runs a single workspace
// through its own `test` script instead.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    projects: [
      'apps/*',
      'packages/*',
      {
        test: {
          name: 'tooling',
          root: import.meta.dirname,
          include: ['scripts/**/*.test.ts'],
        },
      },
      {
        // Testcontainers starts real Postgres and Redis here, so this project is
        // excluded from `pnpm test` and run by `pnpm test:integration`, which CI
        // runs as its own step. Without Docker the suites skip themselves.
        test: {
          name: 'integration',
          root: import.meta.dirname,
          include: ['packages/*/src/**/*.integration.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 300_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      // The gate in ARCHITECTURE §15 applies to `packages/*`; the apps are
      // covered by Playwright from M0-07 onwards.
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      thresholds: {
        lines: 80,
      },
    },
  },
});
