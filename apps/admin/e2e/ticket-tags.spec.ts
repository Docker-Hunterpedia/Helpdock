import AxeBuilder from '@axe-core/playwright';
import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { openTicket, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M1-15 in a real browser, in both languages: the tags row and the editable
 * custom fields of the details panel (artboard `Admin/Ticket-Tags`).
 *
 * What a browser adds over the unit suites is a popover really focused and
 * really dismissed with Esc, a blur that really happens, the Arabic names in an
 * RTL layout, and axe over the picker open and the refusal showing.
 */

test.use({ reducedMotion: 'reduce' });

/** The seeded tags' names as each desk draws them. */
const TAGS = {
  en: { refund: 'Refund', vip: 'VIP', bug: 'Bug', legacy: 'Legacy' },
  ar: { refund: 'استرداد', vip: 'كبار العملاء', bug: 'خلل', legacy: 'قديم' },
} as const;

const ORDER_ID = { en: 'Order id', ar: 'رقم الطلب' } as const;

const details = (page: Page, locale: Locale) =>
  page.getByRole('complementary', { name: strings(locale)('tickets:details.label') });

const violations = async (page: Page): Promise<string[]> => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`,
  );
};

const openPicker = async (page: Page, locale: Locale): Promise<void> => {
  const t = strings(locale);
  await details(page, locale)
    .getByRole('button', { name: t('tickets:details.tagPicker.open') })
    .click();
  await page.getByRole('listbox', { name: t('tickets:details.tagPicker.list') }).waitFor();
};

test.describe('the tags row', () => {
  test('adds a tag from the picker with the keyboard', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    const names = TAGS[locale];
    await signIn(page, locale);
    await openTicket(page, locale);
    await openPicker(page, locale);

    await page
      .getByRole('combobox', { name: t('tickets:details.tagPicker.search') })
      .fill(names.bug);
    await page.keyboard.press('Enter');

    await expect(page.getByRole('option', { name: names.bug })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await violations(page)).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(
      details(page, locale).getByRole('button', {
        name: t('tickets:details.tagPicker.remove', { name: names.bug }),
      }),
    ).toBeVisible();
  });

  test('says where tags are made when none matches', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);
    await openPicker(page, locale);

    await page
      .getByRole('combobox', { name: t('tickets:details.tagPicker.search') })
      .fill('warranty');

    await expect(
      page.getByText(t('tickets:details.tagPicker.noMatch', { term: 'warranty' })),
    ).toBeVisible();
  });

  test('removes a tag with its ×', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    const remove = t('tickets:details.tagPicker.remove', { name: TAGS[locale].vip });
    await signIn(page, locale);
    await openTicket(page, locale);

    await details(page, locale).getByRole('button', { name: remove }).click();

    await expect(details(page, locale).getByRole('button', { name: remove })).toHaveCount(0);
    await expect(
      details(page, locale).getByRole('button', {
        name: t('tickets:details.tagPicker.remove', { name: TAGS[locale].refund }),
      }),
    ).toBeVisible();
  });

  test('puts the chips back when the api refuses the set', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    const names = TAGS[locale];
    await signIn(page, locale);
    // HD-1028 was read before its tag was deleted, so any change names an id
    // the brand no longer has.
    await openTicket(page, locale, 'HD-1028');
    await openPicker(page, locale);

    await page.getByRole('option', { name: names.refund }).click();
    // The popover is modal, so the toast behind it is announced once it closes.
    await page.keyboard.press('Escape');

    await expect(
      page.getByRole('status').filter({ hasText: t('tickets:toast.tagsFailed') }),
    ).toBeVisible();
    const panel = details(page, locale);
    await expect(
      panel.getByRole('button', {
        name: t('tickets:details.tagPicker.remove', { name: names.refund }),
      }),
    ).toHaveCount(0);
    await expect(
      panel.getByRole('button', {
        name: t('tickets:details.tagPicker.remove', { name: names.legacy }),
      }),
    ).toBeVisible();
  });
});

test.describe('the custom fields', () => {
  test('saves a field on blur', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    const field = details(page, locale).getByRole('textbox', { name: ORDER_ID[locale] });
    await field.fill('ORD-5000');
    await field.press('Tab');

    await expect(
      page.getByRole('status').filter({ hasText: t('tickets:toast.updated') }),
    ).toBeVisible();
    await expect(field).toHaveValue('ORD-5000');
  });

  test('shows the api’s refusal under the field and reverts it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    const field = details(page, locale).getByRole('textbox', { name: ORDER_ID[locale] });
    // Longer than the 2,000 characters a text value may hold.
    await field.fill('x'.repeat(2001));
    await field.press('Tab');

    await expect(details(page, locale).getByRole('alert')).toHaveText(
      t('tickets:details.customRefused.text'),
    );
    await expect(field).toHaveValue('ORD-4812');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(await violations(page)).toEqual([]);
  });
});
