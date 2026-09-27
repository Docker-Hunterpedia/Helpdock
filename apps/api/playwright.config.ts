import { defineConfig, devices } from '@playwright/test';
import { HELP_CENTER_URL, PORT } from './e2e/fixtures.ts';

/**
 * The pages the api renders itself — the hosted web form (M4-09) and the help
 * center (M5-03) — in a real browser, once per language, as
 * `apps/admin/playwright.config.ts` runs the admin. The servers are
 * `e2e/web-form-server.ts` and `e2e/help-center-server.ts` over the build, so
 * `pnpm --filter @helpdock/api build` has to have run. The help center spec
 * sets its own `baseURL`.
 */
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${String(PORT)}`;

export default defineConfig<{ pageLocale: 'en' | 'ar' }>({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    { name: 'en', use: { ...devices['Desktop Chrome'], pageLocale: 'en', locale: 'en-GB' } },
    { name: 'ar', use: { ...devices['Desktop Chrome'], pageLocale: 'ar', locale: 'ar-SA' } },
  ],
  webServer: [
    {
      command: 'node e2e/web-form-server.ts',
      url: `${BASE_URL}/_hd/fonts/fonts.css`,
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'node e2e/help-center-server.ts',
      url: `${HELP_CENTER_URL}/_hd/fonts/fonts.css`,
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
