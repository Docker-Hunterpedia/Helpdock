import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Its own config rather than the root one because the unit tests need the React
 * plugin and a DOM. The root `vitest.config.ts` picks this file up through its
 * `apps/*` project glob, so `pnpm test` at the root runs it too; the project
 * name has to stay the package name for `--project @helpdock/admin` to select it.
 *
 * `@helpdock/ui`, `@helpdock/i18n` and `@helpdock/schemas` are aliased to their
 * sources so the suite
 * runs on a clean clone without building the workspace first. Both packages
 * compile from exactly these files, and their own suites test the built output.
 * sources so the suite runs on a clean clone without building the workspace
 * first. Each package compiles from exactly these files, and its own suite
 * tests the built output.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Anchored patterns: the subpath exports (`@helpdock/ui/fonts.css`) have to
    // keep resolving through the package's own `exports` map.
    alias: [
      {
        find: /^@helpdock\/ui$/,
        replacement: new URL('../../packages/ui/src/index.ts', import.meta.url).pathname,
      },
      {
        find: /^@helpdock\/i18n$/,
        replacement: new URL('../../packages/i18n/src/index.ts', import.meta.url).pathname,
      },
      {
        find: /^@helpdock\/schemas$/,
        replacement: new URL('../../packages/schemas/src/index.ts', import.meta.url).pathname,
      },
    ],
  },
  test: {
    name: '@helpdock/admin',
    root: import.meta.dirname,
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx', 'src/vite-env.d.ts'],
      thresholds: {
        lines: 70,
      },
    },
  },
});
