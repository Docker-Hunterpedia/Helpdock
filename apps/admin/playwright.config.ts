import { defineConfig, devices } from '@playwright/test';
import type { LocaleOption } from './e2e/fixtures.js';

const PORT = 5273;

/**
 * Set when the browsers run somewhere other than this machine — the baseline
 * script points a containerised Playwright at the dev server on the host — in
 * which case this config must not try to start a server of its own.
 */
const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const BASE_URL = externalBaseUrl ?? `http://localhost:${PORT}`;

/**
 * Every spec runs twice, once per locale, because an RTL layout is a different
 * layout (DESIGN §7) and half the bugs only appear in one of them.
 *
 * The `@screenshot` tests are excluded from `pnpm e2e` and run by
 * `pnpm e2e:screenshots` instead. Their baselines are Linux pixels, so the
 * comparison fails anywhere else; `pnpm e2e` has to be a command a contributor
 * can run on any machine, and CI runs the comparison as a step of its own.
 * `apps/admin/README.md` says where the baselines come from.
 */
export default defineConfig<LocaleOption>({
  testDir: './e2e',
  // `e2e/api/` is the project that drives a real api, and it has its own
  // config: it needs containers and a differently configured dev server, so it
  // must not be swept up by a run of the mock suite.
  testIgnore: '**/api/**',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : [['list']],
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    // The screenshots are page-sized, so the viewport is the artboard width.
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    { name: 'en', use: { ...devices['Desktop Chrome'], appLocale: 'en', locale: 'en-GB' } },
    { name: 'ar', use: { ...devices['Desktop Chrome'], appLocale: 'ar', locale: 'ar-SA' } },
  ],
  ...(externalBaseUrl
    ? {}
    : {
        webServer: {
          // The dev server rather than a preview of `dist/`, so a run always
          // tests the working tree instead of whatever was built last.
          command: `pnpm exec vite --port ${PORT} --strictPort`,
          url: BASE_URL,
          reuseExistingServer: !process.env.CI,
          stdout: 'ignore' as const,
          stderr: 'pipe' as const,
          env: { VITE_AUTH_API: 'mock' },
        },
      }),
});
