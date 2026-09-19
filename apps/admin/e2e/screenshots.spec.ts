import { MOCK_EMAIL } from '../src/auth/mock-api.js';
import { expect, test } from './fixtures.js';
import { openContact, openContacts, signIn, submitPassword } from './flows.js';
import { strings } from './strings.js';

/**
 * One baseline per screen per locale, so an accidental layout change in either
 * direction shows up as a picture rather than as a reviewer's hunch.
 *
 * Tagged `@screenshot` and left out of `pnpm e2e`: the baselines are Linux
 * pixels, so a comparison anywhere else fails for a reason unrelated to the
 * code. `pnpm e2e:screenshots` runs it, and CI runs that as a step of its own.
 * The baselines come from `.github/workflows/screenshots.yml`;
 * `apps/admin/README.md` says why they are generated there.
 */
test.describe('reference screens @screenshot', () => {
  test('sign in', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByRole('heading', { level: 1 }).waitFor();

    await expect(page).toHaveScreenshot('sign-in.png', { fullPage: true });
  });

  test('the code screen', async ({ page, appLocale: locale }) => {
    await submitPassword(page, locale);
    await page.getByRole('heading', { level: 1 }).waitFor();
    // The field autofocuses, so the caret would blink through the comparison.
    await page.getByLabel(strings(locale)('auth:totp.codeLabel')).blur();

    await expect(page).toHaveScreenshot('totp.png', { fullPage: true });
  });

  test('the sign-in link confirmation', async ({ page, appLocale: locale }) => {
    const t = strings(locale);

    await page.goto('/sign-in');
    await page.getByLabel(t('auth:signIn.emailLabel')).fill(MOCK_EMAIL);
    await page.getByRole('button', { name: t('auth:signIn.magicLink') }).click();
    await page.getByRole('heading', { name: t('auth:magicLink.title') }).waitFor();

    await expect(page).toHaveScreenshot('magic-link-sent.png', { fullPage: true });
  });

  test('the shell', async ({ page, appLocale: locale }) => {
    await signIn(page, locale);

    await expect(page).toHaveScreenshot('shell-tickets.png', { fullPage: true });
  });

  test('an admin page', async ({ page, appLocale: locale }) => {
    const t = strings(locale);

    await signIn(page, locale);
    await page.getByRole('link', { name: new RegExp(t('admin:nav.settings')) }).click();
    await page.getByRole('heading', { level: 1 }).waitFor();

    await expect(page).toHaveScreenshot('shell-settings.png', { fullPage: true });
  });

  test('the contact list', async ({ page, appLocale: locale }) => {
    await signIn(page, locale);
    await openContacts(page, locale);
    // The heading renders before the rows do, so wait for the table itself.
    await page.getByRole('table').waitFor();

    await expect(page).toHaveScreenshot('contacts-list.png', { fullPage: true });
  });

  test('one contact', async ({ page, appLocale: locale }) => {
    await signIn(page, locale);
    // The fixture's fullest contact: a verified identifier beside unverified
    // ones, an account, a note, every stat and an open duplicate suggestion.
    await openContact(page, locale, 'Mona Khalil');

    await expect(page).toHaveScreenshot('contact-detail.png', { fullPage: true });
  });
});
