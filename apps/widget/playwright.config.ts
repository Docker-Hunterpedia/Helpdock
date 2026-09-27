import { defineConfig, devices } from '@playwright/test';

const PORT = 5275;
const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const BASE_URL = externalBaseUrl ?? `http://localhost:${PORT}`;

/**
 * The widget on the harness page (`harness/`) with the mock transport. The
 * locale is part of each test's URL rather than a project, because the harness
 * takes every setting from the query string.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    ...devices['Desktop Chrome'],
    viewport: { width: 1024, height: 800 },
    // A fake microphone, granted, so the voice recorder (M4-07) records for real.
    permissions: ['microphone'],
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  ...(externalBaseUrl
    ? {}
    : {
        webServer: {
          command: `pnpm exec vite --config vite.harness.config.ts --port ${PORT} --strictPort`,
          url: BASE_URL,
          reuseExistingServer: !process.env.CI,
          stdout: 'ignore' as const,
          stderr: 'pipe' as const,
        },
      }),
});
