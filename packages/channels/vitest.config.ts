import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The IMAP integration test needs Docker (GreenMail), so it belongs to the
// root `integration` project and is kept out of the unit run.
export default defineConfig({
  resolve: {
    alias: {
      // Workspace packages resolve to `dist/` through their `exports` map, which
      // would make a test run against the last build instead of the source.
      '@helpdock/schemas': fileURLToPath(new URL('../schemas/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: '@helpdock/channels',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
  },
});
