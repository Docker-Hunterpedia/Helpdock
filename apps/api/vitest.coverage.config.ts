import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * `pnpm --filter @helpdock/api test:coverage`: the unit suites *and* the
 * integration suites, with one coverage number for `src/`.
 *
 * Both, because half of this app — the controller, the guards, the request
 * lifecycle, the tenant transaction — is only exercised over HTTP against a
 * real database. A figure from the unit run alone would say more about where
 * the tests are than about what is covered, and a gate on it would mean
 * nothing.
 *
 * It needs Docker: without it the integration suites skip themselves and say
 * so, and the number comes out low rather than absent.
 *
 * It is a whole config rather than a merge of `vitest.config.ts` because
 * `mergeConfig` concatenates arrays, and what this needs is to *replace* that
 * file's exclusion of the integration suites.
 */
export default defineConfig({
  resolve: {
    // One copy of zod and of its Nest bindings, whatever a workspace package
    // resolves for itself. Two copies make `error instanceof ZodError` false,
    // and a failed input schema would answer 500 instead of 400 — in the test
    // run only, which is the worst place for a difference to live.
    dedupe: ['zod', 'nestjs-zod'],
    alias: {
      '@helpdock/config': fileURLToPath(
        new URL('../../packages/config/src/index.ts', import.meta.url),
      ),
      '@helpdock/db': fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
      '@helpdock/jobs': fileURLToPath(new URL('../../packages/jobs/src/index.ts', import.meta.url)),
      '@helpdock/schemas': fileURLToPath(
        new URL('../../packages/schemas/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: '@helpdock/api-coverage',
    include: ['src/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        // Test scaffolding, the process entry point and the CLI wrapper around
        // `dev-seed.ts`: none is behaviour this app has to get right, and all
        // of them are exercised by running the app at all.
        'src/testing/**',
        'src/main.ts',
        'src/seed/seed-dev.ts',
      ],
      thresholds: { lines: 90 },
    },
  },
});
