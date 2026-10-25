import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.HD_SITE_E2E_PORT ?? 4322);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Smoke tests of the built website (`pnpm build` first). `dist/` is served by
 * a small static server that answers as GitHub Pages does, 404.html included;
 * `astro preview` detaches into the background when it has no terminal, which
 * Playwright cannot wait on.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: `node e2e/static-server.ts ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
