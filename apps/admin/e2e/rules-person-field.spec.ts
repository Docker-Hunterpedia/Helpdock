import AxeBuilder from '@axe-core/playwright';
import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { openSettingsArea, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M14-27 in the rule builder, in both languages: a person field is picked by
 * name (never a typed id) in a condition and in a "set field" action, and a
 * long text field is searched with "contains".
 */

test.use({ reducedMotion: 'reduce' });

const MEMBER = 'Omar Aziz';
const OWNER = { en: 'Owner', ar: 'المالك' } as const;
const NOTES = { en: 'Notes', ar: 'ملاحظات' } as const;

const violations = async (page: Page): Promise<string[]> => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`,
  );
};

const newRule = async (page: Page, locale: Locale): Promise<void> => {
  const t = strings(locale);
  await signIn(page, locale);
  await openSettingsArea(page, t, 'automation');
  await page.getByRole('list', { name: t('rules:list.rules.caption') }).waitFor();
  await page.getByRole('link', { name: t('rules:newRule') }).click();
};

test('a condition on a person field is a name picker with equality operators only', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await newRule(page, locale);

  await page
    .getByRole('combobox', { name: t('rules:builder.field') })
    .selectOption({ label: t('rules:fields.custom', { label: OWNER[locale] }) });

  const operators = await page
    .getByRole('combobox', { name: t('rules:builder.operator') })
    .locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  expect(operators).toEqual(['is', 'is_not', 'is_set']);

  // The failure path: no one chosen yet, so the rule is not complete.
  await page
    .getByLabel(`${t('rules:builder.name')} · ${t('rules:builder.required')}`)
    .fill('Owned by Omar');
  await page.getByRole('button', { name: t('rules:builder.save') }).click();
  await expect(page.getByText(t('rules:builder.incomplete'))).toBeVisible();

  await page.getByRole('combobox', { name: t('rules:builder.value') }).selectOption(MEMBER);
  await page
    .getByRole('combobox', { name: t('rules:fields.team') })
    .selectOption({ label: 'Technical' });
  expect(await violations(page)).toEqual([]);
  await page.getByRole('button', { name: t('rules:builder.save') }).click();

  await expect(
    page.getByRole('form', { name: t('rules:builder.formLabel', { name: 'Owned by Omar' }) }),
  ).toBeVisible();
  await openSettingsArea(page, t, 'automation');
  // The sentence says who, in words.
  await expect(page.getByRole('listitem').filter({ hasText: 'Owned by Omar' })).toContainText(
    MEMBER,
  );
});

test('a set-field action on a person field picks the person by name', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await newRule(page, locale);

  await page
    .getByLabel(`${t('rules:builder.name')} · ${t('rules:builder.required')}`)
    .fill('Assign the owner');
  await page.getByRole('combobox', { name: t('rules:builder.field') }).selectOption('priority');
  await page.getByRole('combobox', { name: t('rules:builder.value') }).selectOption('urgent');
  await page
    .getByRole('combobox', { name: t('rules:builder.action', { n: 1 }) })
    .selectOption({ label: t('rules:actionTypes.set_field') });
  await page
    .getByRole('combobox', { name: t('rules:builder.customField') })
    .selectOption({ label: OWNER[locale] });

  // The value is a picker of names now, not a text box.
  await expect(page.getByRole('textbox', { name: t('rules:builder.value') })).toHaveCount(0);
  await page
    .getByRole('combobox', { name: t('rules:builder.value') })
    .last()
    .selectOption(MEMBER);
  expect(await violations(page)).toEqual([]);
  await page.getByRole('button', { name: t('rules:builder.save') }).click();

  await expect(
    page.getByRole('form', { name: t('rules:builder.formLabel', { name: 'Assign the owner' }) }),
  ).toBeVisible();
  await openSettingsArea(page, t, 'automation');
  await expect(page.getByRole('listitem').filter({ hasText: 'Assign the owner' })).toContainText(
    MEMBER,
  );
});

test('a long text field starts on "contains"', async ({ page, appLocale: locale }) => {
  const t = strings(locale);
  await newRule(page, locale);

  await page
    .getByRole('combobox', { name: t('rules:builder.field') })
    .selectOption({ label: t('rules:fields.custom', { label: NOTES[locale] }) });

  await expect(page.getByRole('combobox', { name: t('rules:builder.operator') })).toHaveValue(
    'contains',
  );
  await expect(page.getByRole('textbox', { name: t('rules:builder.text') })).toBeVisible();
});
