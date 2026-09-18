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
