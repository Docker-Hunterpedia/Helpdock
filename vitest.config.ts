import { fileURLToPath } from 'node:url';
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
        resolve: {
          alias: {
            // Workspace packages resolve to `dist/` through their `exports` map,
            // which would make a test run against the last build instead of the
            // source. Each workspace project sets the same alias for itself.
            '@helpdock/config': fileURLToPath(
              new URL('packages/config/src/index.ts', import.meta.url),
            ),
            '@helpdock/db': fileURLToPath(new URL('packages/db/src/index.ts', import.meta.url)),
            '@helpdock/schemas': fileURLToPath(
              new URL('packages/schemas/src/index.ts', import.meta.url),
            ),
          },
        },
        test: {
          name: 'integration',
          root: import.meta.dirname,
          include: [
            'packages/*/src/**/*.integration.test.ts',
            'apps/*/src/**/*.integration.test.ts',
          ],
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
