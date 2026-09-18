import { defineConfig } from 'vitest/config';

// Integration tests need Docker, so they belong to the root `integration`
// project and are kept out of the unit run. Everything else here is the Vitest
// default for a workspace directory.
export default defineConfig({
  test: {
    name: '@helpdock/config',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
  },
});
