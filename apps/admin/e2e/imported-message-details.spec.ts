import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures.js';
import { openTicket, signIn } from './flows.js';
import { strings } from './strings.js';

test('reads original source message facts without offering send or retry actions', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicket(page, locale, 'HD-1028');
  const history = page.getByRole('list', { name: t('tickets:thread.label') });
  const disclosure = history
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: t('tickets:importedMessage.title') }) });
  await expect(disclosure.getByText('SUCCESS', { exact: true })).not.toBeVisible();
  await disclosure.locator('summary').click();
  await expect(disclosure.getByText('SUCCESS', { exact: true })).toBeVisible();
  await expect(disclosure.getByText('EMAIL', { exact: true })).toBeVisible();
  await expect(disclosure.getByText('Original transcript request', { exact: true })).toBeVisible();
  await expect(
    disclosure.getByText('Fri, 01 Nov 2013 15:00:00 +0530', { exact: true }),
  ).toBeVisible();
  await expect(disclosure.getByText('<bounce@example.test>', { exact: true })).toBeVisible();
  await expect(
    disclosure.getByText(t('tickets:importedMessage.kinds.customer'), { exact: true }),
  ).toBeVisible();
  await expect(disclosure.getByRole('button')).toHaveCount(0);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(result.violations).toEqual([]);
});
