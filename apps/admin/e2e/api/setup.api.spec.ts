import { expect, test } from '@playwright/test';
import { strings } from '../strings.js';
import { SKIP_ENV } from './install.js';

/**
 * The exit criterion of M0-08: an install nobody has touched, opened in a
 * browser, taken through the wizard, and signed into — against the real api,
 * the real Postgres and the real Redis, with no fixture anywhere in the path.
 *
 * The mock suite covers the four screens in both languages. What this adds is
 * everything under them: the advisory lock on the first account, argon2, the
 * brand's ticket sequence, the row-level security the role insert runs under,
 * the `httpOnly` refresh cookie step 2 sets, and the session the shell reads
 * back from it.
 *
 * It runs against its own install (`playwright.api.config.ts`), because a
 * fresh install is exactly what the seeded one can never be again.
 */

test.skip(
  Boolean(process.env[SKIP_ENV]),
  'Docker is not available, so there is no api to run against.',
);

const t = strings('en');

const ADMIN_NAME = 'Lina Haddad';
const ADMIN_EMAIL = 'lina@example.com';
const ADMIN_PASSWORD = 'a very long setup passphrase';
const BRAND_NAME = 'Acme Support';
const BRAND_PREFIX = 'ACME';

test.describe('the first-run wizard against the real api', () => {
  test('sets the install up and lands in the shell', async ({ page }) => {
    // An install with no accounts has one screen, whatever was asked for.
    await page.goto('/tickets');
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole('heading', { name: t('wizard:title'), level: 1 })).toBeVisible();

    await page.getByLabel(t('wizard:account.nameLabel')).fill(ADMIN_NAME);
    await page.getByLabel(t('wizard:account.emailLabel')).fill(ADMIN_EMAIL);
    await page.getByLabel(t('wizard:account.passwordLabel')).fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: t('wizard:account.submit') }).click();

    await expect(page.getByRole('heading', { name: t('wizard:brand.title') })).toBeVisible();
    await page.getByLabel(t('wizard:brand.nameLabel')).fill(BRAND_NAME);
    await page.getByLabel(t('wizard:brand.prefixLabel')).fill(BRAND_PREFIX);
    await page.getByRole('button', { name: t('wizard:brand.submit') }).click();

    await expect(page.getByRole('heading', { name: t('wizard:email.title') })).toBeVisible();

    // The brand step is where the admin is signed in: before it there is no
    // brand for a session to land in.
    const refresh = (await page.context().cookies()).find((cookie) => cookie.name === 'hd_refresh');
    expect(refresh?.httpOnly).toBe(true);
    expect(refresh?.path).toBe('/api/auth');

    // No relay to point at here, and skipping is a decision the api records.
    await page.getByRole('button', { name: t('wizard:email.skip') }).click();

    await expect(page.getByRole('heading', { name: t('wizard:done.title') })).toBeVisible();
    await expect(page.getByText(ADMIN_EMAIL)).toBeVisible();
    await expect(
      page.getByText(t('wizard:done.brandValue', { name: BRAND_NAME, prefix: BRAND_PREFIX })),
    ).toBeVisible();
    await expect(page.getByText(t('wizard:done.emailSkipped'))).toBeVisible();

    await page.getByRole('button', { name: t('wizard:done.submit') }).click();

    // Into the shell, signed in, with the brand the wizard created.
    await expect(
      page.getByRole('heading', { name: t('tickets:views.myOpen'), level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: t('admin:brandSwitcher.action') })).toContainText(
      BRAND_NAME,
    );
    expect(await page.evaluate(() => JSON.stringify(window.localStorage))).not.toContain('eyJ');
  });

  test('has closed the wizard for good', async ({ page }) => {
    // The install is configured now, so the meta tag says so and the route is
    // not mounted at all.
    await page.goto('/setup');

    await expect(page.getByRole('heading', { name: t('wizard:title') })).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: t('auth:signIn.title'), level: 1 }),
    ).toBeVisible();
  });

  test('refuses a second admin over the wire', async ({ request, baseURL }) => {
    const response = await request.post(`${String(baseURL)}/api/install/setup/admin`, {
      data: {
        name: 'Someone Else',
        email: 'someone@example.com',
        password: 'another very long passphrase',
        locale: 'en',
      },
    });

    expect(response.status()).toBe(409);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'conflict' },
    });
  });
});
