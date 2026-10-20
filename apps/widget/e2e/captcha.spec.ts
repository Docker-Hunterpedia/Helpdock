import {
  expect,
  LOCALES,
  openWidget,
  server,
  strings,
  test,
  violations,
  widgetWindow,
} from './fixtures.js';

/**
 * The built-in check before a first message (M18-10, ADR 0052, artboard
 * `Widget/PreChat-Verify`), with the mock transport and the real WebCrypto
 * solver, in both languages, with axe on each state: checking to verified,
 * and a challenge that could not be fetched, then Try again.
 */

for (const locale of LOCALES) {
  const t = strings(locale);

  test.describe(locale, () => {
    test('checks in the background, then Start chat sends the solution', async ({ page }) => {
      const outside: string[] = [];
      page.on('request', (request) => {
        if (!request.url().startsWith('http://localhost')) outside.push(request.url());
      });
      await openWidget(page, locale, 'prechat=1&captcha=pow');
      const window = widgetWindow(page, locale);

      const check = window.getByRole('group', { name: t('captcha.group') });
      await expect(check.getByRole('status')).toHaveText(t('captcha.pow.verified'));
      await expect(check).toContainText(t('captcha.pow.builtIn'));
      expect(await violations(page)).toEqual([]);

      await window.getByRole('textbox', { name: t('prechat.name') }).fill('Omar Khalil');
      await window.getByRole('textbox', { name: t('prechat.email') }).fill('omar.k@example.com');
      await window
        .getByRole('textbox', { name: t('prechat.message') })
        .fill('My refund for order 8841 has not arrived.');
      await window.getByRole('button', { name: t('prechat.submit') }).click();
      await expect(
        page.getByText(
          t('thread.talkingTo', {
            team: t('header.chatTitle', { brand: 'Helpdock' }),
            email: 'omar.k@example.com',
          }),
        ),
      ).toBeVisible();
      // No provider script: nothing is fetched from a third party.
      expect(outside).toEqual([]);
    });

    test('checks without WebCrypto, as on a page served over http://', async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(window.crypto, 'subtle', { get: () => undefined });
      });
      await openWidget(page, locale, 'prechat=1&captcha=pow');
      const check = widgetWindow(page, locale).getByRole('group', { name: t('captcha.group') });

      await expect(check.getByRole('status')).toHaveText(t('captcha.pow.verified'), {
        timeout: 15_000,
      });
    });

    test('says when the check failed, keeps Start chat off, and passes on Try again', async ({
      page,
    }) => {
      await page.goto(`/?locale=${locale}&prechat=1&captcha=pow`);
      await server(page, 'mock.failNextChallenges(1);');
      await page.getByRole('button', { name: t('launcher.open') }).click();
      const window = widgetWindow(page, locale);

      const check = window.getByRole('group', { name: t('captcha.group') });
      await expect(check.getByRole('alert')).toHaveText(t('captcha.pow.failed'));
      await expect(window.getByRole('button', { name: t('prechat.submit') })).toBeDisabled();
      expect(await violations(page)).toEqual([]);

      await check.getByRole('button', { name: t('captcha.pow.retry') }).click();
      await expect(check.getByRole('status')).toHaveText(t('captcha.pow.verified'));
      await expect(window.getByRole('button', { name: t('prechat.submit') })).toBeEnabled();
    });
  });
}
