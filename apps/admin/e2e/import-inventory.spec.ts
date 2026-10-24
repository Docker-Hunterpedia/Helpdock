import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures.js';
import { openSettingsArea, settingsTab, signIn } from './flows.js';
import { strings } from './strings.js';

// UI-fixture coverage: the real sealing, CSV validation and scope-fingerprint
// refusal are exercised independently by imports.integration.test.ts.
test('connects Freshdesk, maps native IDs and requires renewed inventory confirmation', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openSettingsArea(page, t, 'brand');
  await settingsTab(page, t, 'brand:tabs.import').click();
  await page.getByRole('button', { name: /Freshdesk/ }).click();
  await page.getByLabel(t('imports:connection.freshdeskDomain')).fill('https://invalid.example');
  await page.getByLabel(t('imports:connection.freshdeskKey')).fill('synthetic-test-key');
  await page.getByRole('button', { name: t('imports:connection.test') }).click();
  await expect(page.getByText(t('imports:connection.invalid'))).toBeVisible();
  await expect(page.getByRole('heading', { name: t('imports:inventory.title') })).toHaveCount(0);
  await page.getByLabel(t('imports:connection.freshdeskDomain')).fill('example');
  await page.getByRole('button', { name: t('imports:connection.test') }).click();
  await expect(page.getByRole('heading', { name: t('imports:inventory.title') })).toBeVisible();
  const extract = page.getByRole('button', { name: t('imports:scope.extract') });
  const confirmation = page.getByRole('checkbox', { name: t('imports:inventory.confirm') });
  await expect(extract).toBeDisabled();
  await expect(confirmation).toBeDisabled();
  await page.getByLabel(t('imports:files.choose')).setInputFiles({
    name: 'ticket-inventory.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'Ticket ID,Title,Created,State\n39812,Refund,2024-03-14T10:02:00.000Z,closed\n',
    ),
  });
  await page.getByRole('button', { name: t('imports:files.upload') }).click();
  await page.getByRole('button', { name: t('imports:inventory.mappingTitle') }).click();
  const save = page.getByRole('button', { name: t('imports:inventory.save') });
  await expect(save).toBeDisabled();
  await page.getByRole('combobox', { name: t('imports:inventory.idColumn') }).click();
  await page.getByRole('option', { name: 'Ticket ID', exact: true }).click();
  await expect(
    page.getByRole('table', { name: t('imports:inventory.preview') }).getByText('39812'),
  ).toBeVisible();
  await expect(extract).toBeDisabled();
  await save.click();
  await expect(
    page.getByText(t('imports:inventory.validated', { records: '1', duplicates: '0' })),
  ).toBeVisible();
  await expect(confirmation).toBeEnabled();
  await confirmation.check();
  await expect(extract).toBeEnabled();
  await page.getByRole('combobox', { name: t('imports:inventory.mode') }).click();
  await page.getByRole('option', { name: t('imports:inventory.modes.complete') }).click();
  await expect(confirmation).not.toBeChecked();
  await expect(extract).toBeDisabled();
  await confirmation.check();
  await extract.evaluate(async (button) => {
    await Promise.all(button.getAnimations().map((animation) => animation.finished));
  });
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await extract.click();
  await expect(page.getByRole('heading', { name: t('imports:run.progress') })).toBeVisible();
});
