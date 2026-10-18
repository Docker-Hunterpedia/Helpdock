import { defineConfig, devices } from '@playwright/test';
import { IMPORT_API_ORIGIN, IMPORT_WEB_ORIGIN, IMPORT_WEB_PORT } from './e2e/api/import-install.js';
import type { LocaleOption } from './e2e/fixtures.js';

export default defineConfig<LocaleOption>({
  testDir: './e2e/api',
  testMatch: /imports\.import\.spec\.ts/,
  globalSetup: './e2e/api/import-global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 180000,
  reporter: [['list']],
  use: {
    baseURL: IMPORT_WEB_ORIGIN,
    viewport: { width: 1280, height: 800 },
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'en', use: { ...devices['Desktop Chrome'], appLocale: 'en', locale: 'en-GB' } },
    { name: 'ar', use: { ...devices['Desktop Chrome'], appLocale: 'ar', locale: 'ar-SA' } },
  ],
  webServer: {
    command: `pnpm exec vite --port ${IMPORT_WEB_PORT} --strictPort`,
    url: IMPORT_WEB_ORIGIN,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { VITE_AUTH_API: 'http', VITE_API_ORIGIN: IMPORT_API_ORIGIN },
  },
});
