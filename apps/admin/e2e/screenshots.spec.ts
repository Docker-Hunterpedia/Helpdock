import { MOCK_EMAIL } from '../src/auth/mock-api.js';
import { expect, test } from './fixtures.js';
import { signIn, submitPassword } from './flows.js';
import { strings } from './strings.js';

/**
 * One baseline per screen per locale, so an accidental layout change in either
 * direction shows up as a picture rather than as a reviewer's hunch.
 *
 * Tagged `@screenshot` and left out of `pnpm e2e` until the Linux baselines are
 * committed: a comparison with no baseline on disk fails the run rather than
 * skipping it. `apps/admin/README.md` has the command that generates them.
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
});
