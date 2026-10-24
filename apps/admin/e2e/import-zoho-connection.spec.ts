import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures.js';
import { openSettingsArea, settingsTab, signIn } from './flows.js';
import { strings } from './strings.js';

// Each configured locale runs this UI fixture; native API/profile checks use
// the independent Zoho stand-in and the API integration suite.
test('connects Zoho in the selected region after correcting an invalid organization ID', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openSettingsArea(page, t, 'brand');
  await settingsTab(page, t, 'brand:tabs.import').click();
  await page.getByRole('button', { name: /Zoho Desk/ }).click();
  await expect(page.getByText(t('imports:connection.zoho.caption'))).toBeVisible();
  await page.getByRole('combobox', { name: t('imports:connection.zoho.region') }).click();
  await page.getByRole('option', { name: t('imports:connection.zoho.regions.eu') }).click();
  const organization = page.getByLabel(t('imports:connection.zoho.orgId'));
  await organization.fill('invalid');
  await page.getByLabel(t('imports:connection.zoho.clientId')).fill('synthetic-client');
  for (const field of ['clientSecret', 'refreshToken'] as const) {
    const secret = page.getByLabel(t(`imports:connection.zoho.${field}`));
    await expect(secret).toHaveAttribute('type', 'password');
    await expect(secret).toHaveAttribute('dir', 'ltr');
    await secret.fill(`synthetic-${field}`);
  }
  await page.getByRole('button', { name: t('imports:connection.test') }).click();
  await expect(page.getByText(t('imports:connection.invalid'))).toBeVisible();
  await expect(page.getByRole('heading', { name: t('imports:scope.title') })).toHaveCount(0);
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await organization.fill('90071992547409931234');
  await page.getByRole('button', { name: t('imports:connection.test') }).click();
  await expect(page.getByRole('heading', { name: t('imports:scope.title') })).toBeVisible();
  await expect(page.getByText('eu:90071992547409931234', { exact: false })).toBeVisible();
  await expect(page.getByLabel(t('imports:connection.zoho.clientSecret'))).toHaveCount(0);
  await expect(page.getByLabel(t('imports:connection.zoho.refreshToken'))).toHaveCount(0);
  const extract = page.getByRole('button', { name: t('imports:scope.extract') });
  await expect(extract).toBeEnabled();
  await expect(page.getByRole('heading', { name: t('imports:inventory.title') })).toHaveCount(0);
  const fallback = page.getByRole('checkbox', { name: t('imports:inventory.useFallback') });
  await fallback.check();
  await expect(page.getByRole('heading', { name: t('imports:inventory.title') })).toBeVisible();
  await expect(extract).toBeDisabled();
  await fallback.uncheck();
  await expect(extract).toBeEnabled();
  await extract.click();
  await expect(page.getByRole('heading', { name: t('imports:run.progress') })).toBeVisible();
});
