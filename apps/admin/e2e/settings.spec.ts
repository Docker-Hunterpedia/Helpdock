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

  test('copies a redirect URL whole, from a button that names it', async ({
    page,
    context,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await signIn(page, locale);
    await openSettings(page, locale);

    await page
      .getByRole('button', {
        name: t('settings:aside.redirectUrls.copy', { provider: t('settings:oauth.google') }),
      })
      .click();

    await expect(page.getByText(t('settings:aside.redirectUrls.copied'))).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'http://localhost:5273/api/auth/oauth/google/callback',
    );
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

  test('saves the Microsoft tenant and secret, and refuses a tenant that is not a GUID', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSettings(page, locale);
    await expect(
      page.getByText('http://localhost:5273/api/auth/oauth/microsoft/callback'),
    ).toBeVisible();

    const tenant = page.getByLabel(t('settings:oauth.tenantId'));
    await tenant.fill('organizations');
    await page.getByRole('button', { name: t('common:actions.save') }).click();
    await expect(page.getByText(t('settings:oauth.tenantIdInvalid'))).toBeVisible();
    await expect(tenant).toHaveAccessibleDescription(t('settings:oauth.tenantIdInvalid'));

    await tenant.fill('3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f');
    await page.getByLabel(t('settings:oauth.microsoftClientId')).fill('ms-app-id');
    await page.getByLabel(t('settings:oauth.microsoftClientSecret')).fill('ms-secret');
    await page.getByRole('button', { name: t('common:actions.save') }).click();

    await expect(page.getByText(t('settings:saved'))).toBeVisible();
    await expect(page.locator('input[value="ms-secret"]')).toHaveCount(0);
    await expect(
      page.getByRole('button', {
        name: t('settings:oauth.replaceLabel', { provider: t('settings:oauth.microsoft') }),
      }),
    ).toBeVisible();
    await expect(tenant).toHaveValue('3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f');
  });

  test('keeps personal Microsoft accounts off until they are ticked, and saves the choice', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSettings(page, locale);

    const box = page.getByRole('checkbox', {
      name: new RegExp(t('settings:oauth.allowConsumers')),
    });
    await expect(box).not.toBeChecked();
    await box.check();
    await page.getByRole('button', { name: t('common:actions.save') }).click();

    await expect(page.getByText(t('settings:saved'))).toBeVisible();
    await expect(box).toBeChecked();
  });

  test('limits Google sign-in to the Workspace domains it lists', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSettings(page, locale);
    const domains = page.getByLabel(t('settings:oauth.allowedDomains'));

    await domains.fill('lina@gmail.com');
    await domains.press('Enter');
    await expect(page.getByText(t('settings:oauth.allowedDomainsInvalid'))).toBeVisible();

    await domains.fill('Helpdock.com');
    await domains.press('Enter');
    await expect(page.getByRole('button', { name: 'helpdock.com' })).toBeVisible();
    await page.getByRole('button', { name: t('common:actions.save') }).click();

    await expect(page.getByText(t('settings:saved'))).toBeVisible();
    await expect(page.getByRole('button', { name: 'helpdock.com' })).toBeVisible();
    await expect(page.getByText(t('settings:oauth.allowedDomainsInvalid'))).toBeHidden();
  });
});
