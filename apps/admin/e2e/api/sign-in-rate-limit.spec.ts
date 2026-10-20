import { expect, test } from '../fixtures.js';
import { strings } from '../strings.js';

for (const [seconds, minutes] of [
  [1, 1],
  [61, 2],
  [121, 3],
  [661, 12],
  [899, 15],
] as const) {
  test(`announces a 429 and rounds ${seconds} seconds to ${minutes} minutes`, async ({
    page,
    appLocale,
  }) => {
    const t = strings(appLocale);
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/auth/methods') {
        await route.fulfill({
          json: {
            password: true,
            magicLink: true,
            sso: [],
            ssoEnforced: false,
            oauth: { google: false, github: false },
            passkey: false,
            passkeysPaused: false,
          },
        });
      } else if (path === '/api/auth/sign-in') {
        await route.fulfill({
          status: 429,
          headers: { 'Retry-After': String(seconds) },
          json: {
            error: {
              code: 'rate_limited',
              message: 'Too many sign-in attempts',
              requestId: 'test',
              auth: { code: 'rate-limited' },
            },
          },
        });
      } else {
        await route.fulfill({
          status: 401,
          json: { error: { code: 'unauthenticated', message: 'Sign in', requestId: 'test' } },
        });
      }
    });
    await page.goto('/sign-in');
    await page.getByLabel(t('auth:signIn.emailLabel')).fill('person@example.com');
    await page.getByLabel(t('auth:signIn.passwordLabel')).fill('password');
    await page.getByRole('button', { name: t('auth:signIn.submit'), exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(
      t('auth:signIn.rateLimited', { count: minutes }),
    );
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.locator('html')).toHaveAttribute('dir', appLocale === 'ar' ? 'rtl' : 'ltr');
  });
}
