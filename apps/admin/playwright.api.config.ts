import { defineConfig, devices } from '@playwright/test';
import {
  E2E_API_ORIGIN,
  E2E_SETUP_ORIGIN,
  E2E_WEB_ORIGIN,
  E2E_WEB_PORT,
} from './e2e/api/install.js';

/**
 * Two projects, both the admin app built with `VITE_AUTH_API=http` and driven
 * against a real api with a real Postgres and a real Redis behind it.
 *
 * `api` runs against the seeded install through the Vite dev server, which
 * proxies `/api` so the two share an origin. `setup` runs against a second
 * install that nobody has set up — what the first-run wizard needs and what the
 * seeded one can never be again — and goes straight at that api, which serves
 * `apps/admin/dist` itself. It has to: the install state reaches the app as a
 * meta tag the api rewrites into `index.html`, and a dev server serves its own
 * copy of that file with the development fixture in it.
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
  projects: [
    {
      name: 'api',
      testMatch: /sign-in\.api\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: E2E_WEB_ORIGIN, locale: 'en-GB' },
    },
    {
      name: 'setup',
      testMatch: /setup\.api\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: E2E_SETUP_ORIGIN, locale: 'en-GB' },
    },
  ],
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
