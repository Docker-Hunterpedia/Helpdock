import { expect, test } from '../fixtures.js';
import { strings } from '../strings.js';

/**
 * The sign-in screens against the real HTTP client, with the api answering
 * what an install without a system sender answers (#369): `email-unavailable`.
 * The refusal must say that email sign-in is unavailable and point to an
 * admin, for every address alike — never "check your email".
 *
 * Runs from `playwright.auth-refusals.config.ts`, which serves the app with
 * `VITE_AUTH_API=http` and stubs the network, in English and Arabic.
 */

const METHODS = {
  password: true,
  magicLink: true,
  sso: [],
  ssoEnforced: false,
  oauth: { google: false, microsoft: false, github: false },
  passkey: false,
  passkeysPaused: false,
};

const REFUSAL = {
  status: 503,
  json: {
    error: {
      code: 'unavailable',
      message: 'This install has no outgoing email server',
      requestId: 'test',
      auth: { code: 'email-unavailable' },
    },
  },
};

test('a sign-in link is refused honestly while the install has no sender', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await page.route('**/api/auth/methods', (route) => route.fulfill({ json: METHODS }));
  await page.route('**/api/auth/magic-link', (route) => route.fulfill(REFUSAL));
  await page.goto('/sign-in');

  await page.getByLabel(t('auth:signIn.emailLabel')).fill('person@example.com');
  await page.getByRole('button', { name: t('auth:signIn.magicLink') }).click();

  await expect(page.getByRole('alert')).toHaveText(t('auth:emailUnavailable'));
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('a password reset is refused the same way, for any address', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await page.route('**/api/auth/methods', (route) => route.fulfill({ json: METHODS }));
  await page.route('**/api/auth/password/forgot', (route) => route.fulfill(REFUSAL));
  await page.goto('/sign-in');

  await page.getByLabel(t('auth:signIn.emailLabel')).fill('person@example.com');
  await page.getByRole('button', { name: t('auth:signIn.forgotPassword') }).click();

  await expect(page.getByRole('alert')).toHaveText(t('auth:emailUnavailable'));
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
});
