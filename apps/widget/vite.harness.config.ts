import { defineConfig } from 'vite';

/** `pnpm --filter @helpdock/widget dev`: the harness page the Playwright suite drives. */
export default defineConfig({
  root: 'harness',
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  server: { port: 5275 },
});
