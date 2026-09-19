import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Integration tests need Docker, so they belong to the root `integration`
// project and are kept out of the unit run.
export default defineConfig({
  resolve: {
    alias: {
      // Workspace packages resolve to `dist/` through their `exports` map, which
      // would make a test run against the last build instead of the source.
      '@helpdock/config': fileURLToPath(
        new URL('../../packages/config/src/index.ts', import.meta.url),
      ),
      '@helpdock/db': fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
      '@helpdock/schemas': fileURLToPath(
        new URL('../../packages/schemas/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: '@helpdock/api',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
  },
});
