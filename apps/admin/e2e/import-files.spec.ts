import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures.js';
import { openSettingsArea, settingsTab, signIn } from './flows.js';
import { strings } from './strings.js';

test('maps a manual export, saves a preset and blocks extraction after an invalid edit', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openSettingsArea(page, t, 'brand');
  await settingsTab(page, t, 'brand:tabs.import').click();
  await page
    .getByRole('button')
    .filter({ hasText: t('imports:sources.file') })
    .click();
  await page.getByLabel(t('imports:connection.dataset')).fill('historical-export');
  await page.getByRole('button', { name: t('imports:connection.test') }).click();
  const extract = page.getByRole('button', { name: t('imports:scope.extract') });
  await expect(extract).toBeDisabled();
  await page.getByLabel(t('imports:files.choose')).setInputFiles({
    name: 'tickets.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'Ticket ID,Title,Created,State\n39812,Refund for order 4412 not received,2024-03-14T10:02:00.000Z,closed\n',
    ),
  });
  await page.getByRole('button', { name: t('imports:files.upload') }).click();
  const validate = page.getByRole('button', { name: t('imports:columns.validate') });
  await expect(validate).toBeDisabled();
  const destinations = page.getByRole('combobox', {
    name: t('imports:columns.destination'),
    exact: true,
  });
  const choose = async (index: number, name: string) => {
    await destinations.nth(index).click();
    await page.getByRole('option', { name, exact: true }).click();
  };
  for (const [index, field] of (
    ['externalId', 'subject', 'createdAt', 'status'] as const
  ).entries())
    await choose(index, t(`imports:columns.fields.${field}`));
  await page
    .getByRole('button', { name: t('imports:columns.duplicate') })
    .nth(2)
    .click();
  await choose(4, t('imports:columns.fields.updatedAt'));
  await validate.click();
  await expect(page.getByRole('table', { name: t('imports:columns.preview') })).toBeVisible();
  await expect(extract).toBeEnabled();
  await page.getByLabel(t('imports:columns.presetName')).fill('Historical ticket columns');
  await page.getByRole('button', { name: t('imports:columns.savePreset') }).click();
  await expect(page.getByText(t('imports:columns.presetSaved'))).toBeVisible();
  await choose(4, t('imports:columns.fields.externalId'));
  await expect(page.getByText(t('imports:columns.invalidMapping'))).toBeVisible();
  await expect(page.getByText(t('imports:columns.previewStale'))).toBeVisible();
  await expect(validate).toBeDisabled();
  await expect(extract).toBeDisabled();
  await choose(4, t('imports:columns.fields.updatedAt'));
  await validate.click();
  await expect(extract).toBeEnabled();
  await extract.evaluate(async (button) => {
    await Promise.all(button.getAnimations().map((animation) => animation.finished));
  });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await extract.click();
  await expect(page.getByRole('heading', { name: t('imports:run.progress') })).toBeVisible();
});
