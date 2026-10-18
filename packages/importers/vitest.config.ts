import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Workspace packages resolve to `dist/` through their `exports` map, which
      // would make a test run against the last build instead of the source.
      '@helpdock/net': fileURLToPath(new URL('../net/src/index.ts', import.meta.url)),
      '@helpdock/schemas': fileURLToPath(new URL('../schemas/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: '@helpdock/importers',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
  },
});
