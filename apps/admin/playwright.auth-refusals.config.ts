import { defineConfig, devices } from '@playwright/test';
import type { LocaleOption } from './e2e/fixtures.js';

/** Exercises HTTP error mapping without starting a real API. */
export default defineConfig<LocaleOption>({
  testDir: './e2e/api',
  testMatch: 'sign-in-rate-limit.spec.ts',
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  use: { baseURL: 'http://localhost:5274' },
  projects: [
    { name: 'en', use: { ...devices['Desktop Chrome'], appLocale: 'en', locale: 'en-GB' } },
    { name: 'ar', use: { ...devices['Desktop Chrome'], appLocale: 'ar', locale: 'ar-SA' } },
  ],
  webServer: {
    command: 'pnpm exec vite --port 5274 --strictPort',
    url: 'http://localhost:5274',
    reuseExistingServer: false,
    env: { VITE_AUTH_API: 'http' },
  },
});
