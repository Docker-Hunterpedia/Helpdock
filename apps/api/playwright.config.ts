import { defineConfig, devices } from '@playwright/test';
import { PORT } from './e2e/fixtures.ts';

/**
 * The pages the api renders itself — today the hosted web form (M4-09) — in a
 * real browser, once per language, as `apps/admin/playwright.config.ts` runs
 * the admin. The server is `e2e/web-form-server.ts` over the build, so
 * `pnpm --filter @helpdock/api build` has to have run.
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
  webServer: {
    command: 'node e2e/web-form-server.ts',
    url: `${BASE_URL}/_hd/fonts/fonts.css`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
