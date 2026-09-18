import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Integration tests need Docker, so they belong to the root `integration`
// project and are kept out of the unit run.
export default defineConfig({
  resolve: {
    alias: {
      // Workspace packages resolve to `dist/` through their `exports` map, which
      // would make a test run against the last build instead of the source.
      '@helpdock/config': fileURLToPath(new URL('../config/src/index.ts', import.meta.url)),
      '@helpdock/db': fileURLToPath(new URL('../db/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: '@helpdock/jobs',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
  },
});
