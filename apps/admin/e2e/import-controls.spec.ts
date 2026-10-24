import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures.js';
import { openSettingsArea, settingsTab, signIn } from './flows.js';
import { strings } from './strings.js';

test('pauses, resumes and cancels extraction, filters the log and reopens history', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openSettingsArea(page, t, 'brand');
  await settingsTab(page, t, 'brand:tabs.import').click();
  const history = page.getByRole('region', { name: t('imports:history.title') });
  await expect(history.getByText(t('imports:history.emptyTitle'))).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole('button', { name: /Zendesk/ }).click();
  await page.getByLabel(t('imports:connection.subdomain')).fill('synthetic');
  await page.getByLabel(t('imports:connection.email')).fill('agent@example.test');
  await page
    .getByLabel(t('imports:connection.apiToken'), { exact: true })
    .and(page.locator('input[type=password]'))
    .fill('synthetic-token');
  await page.getByRole('button', { name: t('imports:connection.test') }).click();
  await page.getByRole('button', { name: t('imports:scope.extract') }).click();
  await page.getByRole('button', { name: t('imports:run.pause'), exact: true }).click();
  await expect(page.getByText(t('imports:status.paused'), { exact: true })).toBeVisible();
  await page.getByRole('button', { name: t('imports:run.resume'), exact: true }).click();
  await page.getByRole('button', { name: t('imports:run.pause'), exact: true }).click();
  await page.getByRole('button', { name: t('imports:run.cancel'), exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: t('imports:run.cancel'), exact: true })
    .click();
  await expect(page.getByText(t('imports:status.cancelled'), { exact: true })).toBeVisible();
  const log = page.getByRole('region', { name: t('imports:log.title') });
  await log.getByRole('combobox', { name: t('imports:log.filter') }).click();
  await page.getByRole('option', { name: t('imports:log.levels.error'), exact: true }).click();
  await expect(log.getByText(t('imports:log.empty'))).toBeVisible();
  await expect(page.getByRole('listbox', { includeHidden: true })).toHaveCount(0);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page
    .getByRole('navigation', { name: t('imports:run.breadcrumb') })
    .getByRole('link', { name: t('imports:title'), exact: true })
    .click();
  const table = page.getByRole('table', { name: t('imports:history.title') });
  await expect(table.getByText(t('imports:status.cancelled'), { exact: true })).toBeVisible();
  await table.getByRole('link', { name: t('imports:history.open'), exact: true }).click();
  await expect(page.getByText(t('imports:status.cancelled'), { exact: true })).toBeVisible();
});
