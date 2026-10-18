import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures.js';
import { openTicket, signIn } from './flows.js';
import { strings } from './strings.js';

test('reads original imported satisfaction history without a fabricated score or live survey link', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicket(page, locale, 'HD-1028');
  const history = page.getByRole('list', { name: t('tickets:thread.label') });
  await expect(
    history.getByText(t('tickets:event.importedCsat', { source: 'Freshdesk' }), { exact: false }),
  ).toBeVisible();
  await expect(history.getByText(t('tickets:csat.imported_unscored'))).toBeVisible();
  const disclosure = history
    .locator('summary')
    .filter({ hasText: t('tickets:csat.originalAnswers') });
  await expect(history.getByText('How was the support?')).not.toBeVisible();
  await disclosure.click();
  await expect(history.getByText('How was the support?')).toBeVisible();
  await expect(history.getByText('7', { exact: true })).toBeVisible();
  await expect(history.getByText('The complete original answer is retained.')).toBeVisible();
  await expect(history.getByRole('button', { name: t('tickets:csat.copyLink') })).toHaveCount(0);
  await expect(history.getByText(t('tickets:csat.rated', { rating: 0 }))).toHaveCount(0);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(result.violations).toEqual([]);
});
