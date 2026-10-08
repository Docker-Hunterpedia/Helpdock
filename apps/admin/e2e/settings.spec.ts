import { expectFieldPartsStacked } from './field-layout.js';
import { expect, test } from './fixtures.js';
import { openSettings, signIn } from './flows.js';
import { strings } from './strings.js';

test.describe('install settings', () => {
  test('replaces the shipped placeholder with the authentication settings', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSettings(page, locale);

    await expect(page.getByRole('tab', { name: t('settings:tabs.authentication') })).toBeVisible();
    await expect(page.getByText(t('settings:aside.redirectUrls.title'))).toBeVisible();
    await expect(
      page.getByText('http://localhost:5273/api/auth/oauth/google/callback'),
    ).toBeVisible();

    const validity = page.getByLabel(t('settings:signInMethods.magicLinkValidity'));
    await expectFieldPartsStacked({
      label: page.locator(`label[for="${await validity.getAttribute('id')}"]`),
      control: validity,
    });
  });

  test('saves a provider credential without showing the secret again', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSettings(page, locale);

    const clientIds = page.getByLabel(t('settings:oauth.clientId'));
    await clientIds.nth(1).fill('github-id');
    const githubSecretLabel = page
      .locator('label')
      .filter({ hasText: t('settings:oauth.clientSecret') })
      .last();
    const githubSecretId = await githubSecretLabel.getAttribute('for');
    if (githubSecretId === null) {
      throw new Error('The GitHub client secret label must name its input');
    }
    await page.locator(`input[id="${githubSecretId}"]`).fill('github-secret');
    await page.getByRole('button', { name: t('common:actions.save') }).click();

    await expect(page.getByText(t('settings:saved'))).toBeVisible();
    await expect(page.locator('input[value="github-secret"]')).toHaveCount(0);
    await expect(
      page.getByRole('button', {
        name: t('settings:oauth.replaceLabel', { provider: t('settings:oauth.github') }),
      }),
    ).toBeVisible();
  });
});
