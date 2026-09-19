import { defineConfig, devices } from '@playwright/test';
import { E2E_API_ORIGIN, E2E_WEB_ORIGIN, E2E_WEB_PORT } from './e2e/api/install.js';

/**
 * The `api` project: the admin app built with `VITE_AUTH_API=http`, driven
 * against a real api with a real Postgres and a real Redis behind it.
 *
 * It is a second config rather than a project inside `playwright.config.ts`
 * because a `webServer` and a `globalSetup` belong to a whole run, not to a
 * project: adding this one to the main config would start containers for the
 * mock suite too, and would fail it on a machine with no Docker.
 *
 * English only. The Arabic layout is a property of the screens, which the mock
 * suite already runs twice; what this one adds is the wiring underneath them,
 * and running it twice would double a two-minute container start to prove
 * nothing new.
 */
export default defineConfig({
  testDir: './e2e/api',
  testMatch: /.*\.api\.spec\.ts/,
  globalSetup: './e2e/api/global-setup.ts',
  fullyParallel: false,
  // One worker: the specs share one install and one account, and a sign-out
  // everywhere in one worker would end another worker's session.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 60_000,
  use: {
    baseURL: E2E_WEB_ORIGIN,
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: 'api', use: { ...devices['Desktop Chrome'], locale: 'en-GB' } }],
  webServer: {
    command: `pnpm exec vite --port ${String(E2E_WEB_PORT)} --strictPort`,
    url: E2E_WEB_ORIGIN,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      // The real adapter, and the proxy that makes the api same-origin so the
      // `SameSite=Lax` refresh cookie is sent at all.
      VITE_AUTH_API: 'http',
      VITE_API_ORIGIN: E2E_API_ORIGIN,
    },
  },
});
