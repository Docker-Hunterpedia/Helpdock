import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Workspace packages resolve to `dist/` through their `exports` map, which
      // would make a test run against the last build instead of the source.
      '@helpdock/config': fileURLToPath(new URL('../config/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: '@helpdock/ai',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
  },
});
