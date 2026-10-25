import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.HD_SITE_E2E_PORT ?? 4322);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Smoke tests of the built website (`pnpm build` first). `dist/` is served by
 * a plain static server, as GitHub Pages serves it; `astro preview` detaches
 * into the background when it has no terminal, which Playwright cannot wait on.
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
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1 --directory dist`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
