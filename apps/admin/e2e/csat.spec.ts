import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { MOCK_CSAT_TICKET, MOCK_CSAT_TOKENS } from '../src/csat/mock-api.js';
import { expect, test } from './fixtures.js';
import { strings } from './strings.js';

/**
 * The public rating page (`CsatEN`, `CsatAR`; M1-12) in a real browser, in
 * both languages. The page is reached by its link, with no session, which is
 * exactly how a customer arrives; `?lang=` picks the language the way a channel
 * will for a contact whose language differs from the brand's.
 */

test.use({ reducedMotion: 'reduce' });

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map((violation) => `${violation.id}: ${violation.help}`);
}

const openLink = async (page: Page, token: string, locale: 'en' | 'ar'): Promise<void> => {
  await page.goto(`/csat/${token}?lang=${locale}`);
};

test.describe('the rating page', () => {
  test('asks about the ticket, in the page’s own language and direction', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openLink(page, MOCK_CSAT_TOKENS.open, locale);

    await expect(page.getByRole('heading', { name: t('csat:heading') })).toBeVisible();
    await expect(page.getByText(MOCK_CSAT_TICKET.reference)).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await expect(page).toHaveTitle(t('csat:title'));
    expect(await violations(page)).toEqual([]);
  });

  test('takes a rating and a comment, then thanks the customer', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openLink(page, MOCK_CSAT_TOKENS.open, locale);

    const good = page.getByRole('button', { name: new RegExp(t('csat:ratings.4')) });
    await good.click();
    await expect(good).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('textbox').fill('Quick and kind.');
    await page.getByRole('button', { name: t('csat:submit') }).click();

    await expect(page.getByText(t('csat:thanks'))).toBeVisible();
    await expect(
      page.getByRole('heading', {
        name: t('csat:ratedHeading', { rating: 4, label: t('csat:ratings.4') }),
      }),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('names who closed the ticket by first name', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openLink(page, MOCK_CSAT_TOKENS.open, locale);

    await expect(
      page.getByText(t('csat:closedBy', { name: MOCK_CSAT_TICKET.closedBy }), { exact: false }),
    ).toBeVisible();
  });

  test('asks for a rating before sending', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openLink(page, MOCK_CSAT_TOKENS.open, locale);

    await page.getByRole('button', { name: t('csat:submit') }).click();

    await expect(page.getByRole('alert')).toHaveText(t('csat:chooseRating'));
  });

  for (const [state, token] of [
    ['used', MOCK_CSAT_TOKENS.used],
    ['expired', MOCK_CSAT_TOKENS.expired],
  ] as const) {
    test(`draws one sentence for a link that is ${state}, and nothing about the ticket`, async ({
      page,
      appLocale: locale,
    }) => {
      const t = strings(locale);
      await openLink(page, token, locale);

      await expect(page.getByRole('alert')).toHaveText(t('csat:spent'));
      await expect(page.getByText(MOCK_CSAT_TICKET.subject)).toHaveCount(0);
      await expect(page.getByRole('button', { name: t('csat:submit') })).toHaveCount(0);
      expect(await violations(page)).toEqual([]);
    });
  }

  test('draws a mistyped link as a spent one', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openLink(page, `${'Z'.repeat(43)}.${'z'.repeat(43)}`, locale);

    await expect(page.getByRole('alert')).toHaveText(t('csat:spent'));
  });

  test('never loads the staff app around the page', async ({ page, appLocale: locale }) => {
    await openLink(page, MOCK_CSAT_TOKENS.open, locale);

    await expect(page.getByRole('navigation')).toHaveCount(0);
  });
});

test.describe('the preview (M1-15 part 2)', () => {
  test('draws a sample, says it is one, and thanks for a rating', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openLink(page, 'preview', locale);

    await expect(page.getByRole('status')).toHaveText(t('csat:preview.notice'));
    await expect(
      page.getByText(t('csat:closedBy', { name: t('csat:preview.agent') }), { exact: false }),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await page.getByRole('button', { name: new RegExp(t('csat:ratings.5')) }).click();
    await page.getByRole('button', { name: t('csat:submit') }).click();

    await expect(page.getByText(t('csat:thanks'))).toBeVisible();
  });
});
