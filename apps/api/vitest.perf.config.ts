import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The performance gates of DOMAIN-RULES §14: `perf:tickets` (M1-15),
 * `perf:help-center` and `perf:realtime` (M9-03), each a file filter on the
 * same suite. Its own config because it is neither a unit nor an integration
 * suite — a run takes a quarter of an hour, and its numbers mean something
 * only on the §14 host — so neither `pnpm test` nor `pnpm test:integration`
 * picks it up. See `docs/guides/performance.md`.
 */
export default defineConfig({
  resolve: {
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
    name: '@helpdock/api-perf',
    include: ['src/testing/perf/**/*.perf.ts'],
    // The whole run is one test; its own timeout is set from the settings.
    hookTimeout: 1_800_000,
    reporters: ['verbose'],
  },
});
