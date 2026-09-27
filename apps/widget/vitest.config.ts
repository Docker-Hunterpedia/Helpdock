import { defineConfig } from 'vitest/config';

/**
 * Its own config because the component tests need Preact's JSX and a DOM. The
 * root `vitest.config.ts` picks it up through the `apps/*` glob, so `pnpm
 * test` and CI's `unit` job run it, the size budget test included.
 */
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  test: {
    name: '@helpdock/widget',
    root: import.meta.dirname,
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
