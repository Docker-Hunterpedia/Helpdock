import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * The help center's content screens in a real browser, in both languages
 * (M5-01, M5-02, M5-09): the Articles tab (`Admin/HelpCenter`), the editor
 * (`Admin/HelpCenter-Editor`) and "Who can read it" on Settings.
 *
 * What a browser adds over the unit suite is TipTap itself — typing, the
 * toolbar, an Arabic page edited right to left — a drag handle driven by the
 * keyboard, and axe over each.
 */

test.use({ reducedMotion: 'reduce' });

const violations = async (page: Page): Promise<string[]> => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map(
    (violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`,
  );
};

const openHelpCenter = async (page: Page, locale: 'en' | 'ar'): Promise<void> => {
  const t = strings(locale);
  await page.getByRole('link', { name: new RegExp(t('admin:nav.helpCenter')) }).click();
  await page.getByRole('heading', { name: t('helpCenter:tree.heading') }).waitFor();
};

const RETURNS = { en: 'Returns & refunds', ar: 'المرتجعات والاسترداد' } as const;
const REFUNDS = { en: 'Refunds', ar: 'المبالغ المستردة' } as const;

/** Opens Returns & refunds › Refunds in the tree. */
const expandRefunds = async (page: Page, locale: 'en' | 'ar'): Promise<void> => {
  const t = strings(locale);
  await page
    .getByRole('button', { name: t('helpCenter:tree.expand', { name: RETURNS[locale] }) })
    .click();
  await page
    .getByRole('button', { name: t('helpCenter:tree.expand', { name: REFUNDS[locale] }) })
    .click();
};
/** The fixture's article with both languages: each reader sees it in their own. */
const TIMELINES = { en: 'Refund timelines', ar: 'مواعيد استرداد المبالغ' } as const;

test.describe('the Articles tab', () => {
  test('filters by the section the tree selects and shows each language', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openHelpCenter(page, locale);

    await expandRefunds(page, locale);
    await page.getByRole('button', { name: REFUNDS[locale], exact: true }).click();

    const table = page.getByRole('table', {
      name: t('helpCenter:list.inSection', { name: REFUNDS[locale] }),
    });
    await expect(table.getByRole('row')).toHaveCount(7);
    await expect(table.getByText(t('helpCenter:languages.missing.ar')).first()).toBeAttached();
    await expect(
      page.getByText(t('helpCenter:filters.count', { shown: 6, total: 7 })),
    ).toBeVisible();

    await page.getByRole('combobox', { name: t('helpCenter:filters.visibility') }).click();
    await page
      .getByRole('option', { name: t('helpCenter:visibility.internal'), exact: true })
      .click();
    await expect(table.getByRole('row')).toHaveCount(2);

    expect(await violations(page)).toEqual([]);
  });

  test('reorders an article with the keyboard alone', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openHelpCenter(page, locale);
    await expandRefunds(page, locale);

    await page
      .getByRole('button', { name: t('helpCenter:tree.move', { name: TIMELINES[locale] }) })
      .press('ArrowDown');
    await expect(page.getByText(t('helpCenter:toast.reordered'))).toBeVisible();

    const titles = page.getByRole('treeitem', { level: 3 });
    await expect(titles.nth(0)).toContainText('Refunds to a closed or expired card');
    await expect(titles.nth(1)).toContainText(TIMELINES[locale]);
  });

  test('refuses to delete a published article and says why', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openHelpCenter(page, locale);

    await page
      .getByRole('button', { name: t('helpCenter:list.actions', { title: TIMELINES[locale] }) })
      .click();
    await page.getByRole('menuitem', { name: t('helpCenter:list.menu.delete') }).click();
    await page.getByRole('button', { name: t('helpCenter:list.confirm.submit') }).click();

    await expect(page.getByText(t('helpCenter:refusals.was-published'))).toBeVisible();
  });
});

test.describe('the editor', () => {
  test('writes a new article, formats it and publishes it', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openHelpCenter(page, locale);

    await page
      .getByRole('button', { name: t('helpCenter:newArticle.label') })
      .first()
      .click();
    const body = page.getByRole('textbox', { name: t('helpCenter:editor.body') });
    await body.waitFor();

    await page
      .getByLabel(t('helpCenter:editor.title'), { exact: true })
      .fill('Where is my refund?');
    await body.click();
    await page.keyboard.type('Refunds take three to five days.');
    await page.getByRole('button', { name: t('helpCenter:editor.bold') }).click();
    await page.keyboard.type(' Always.');
    await expect(body.locator('strong')).toHaveText('Always.');
    await page.getByRole('button', { name: t('helpCenter:editor.callout.button') }).click();
    await expect(body.locator('[data-callout="tip"]')).toBeVisible();

    await expect(
      page
        .getByRole('status')
        .filter({ hasText: t('helpCenter:editor.saved', { time: '' }).trim() }),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await page.getByRole('button', { name: t('helpCenter:editor.publish'), exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: t('helpCenter:toast.status.published') }),
    ).toBeVisible();
    await expect(
      page.getByRole('list').getByText(t('helpCenter:panel.activity.actions.published')).first(),
    ).toBeVisible();
  });

  test('edits the Arabic version right to left', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openHelpCenter(page, locale);
    await page.getByRole('link', { name: TIMELINES[locale] }).first().click();

    await page
      .getByRole('group', { name: t('helpCenter:panel.language.group') })
      .getByRole('button', { name: /العربية/ })
      .click();

    const body = page.getByRole('textbox', { name: t('helpCenter:editor.body') });
    await expect(body.locator('xpath=ancestor::*[@dir][1]')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByLabel(t('helpCenter:editor.title'), { exact: true })).toHaveValue(
      'مواعيد استرداد المبالغ',
    );
    await expect(
      page.getByRole('combobox', { name: t('helpCenter:panel.status.heading') }),
    ).toHaveText(t('helpCenter:status.scheduled'));
    expect(await violations(page)).toEqual([]);
  });

  test('refuses a schedule in the past without sending it', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openHelpCenter(page, locale);
    await page.getByRole('link', { name: 'How we calculate restocking fees' }).first().click();

    await page.getByRole('combobox', { name: t('helpCenter:panel.status.heading') }).click();
    await page.getByRole('option', { name: t('helpCenter:status.scheduled') }).click();
    await page.getByLabel(t('helpCenter:panel.status.date')).fill('2020-01-01');
    await page.getByRole('button', { name: t('helpCenter:editor.schedule') }).click();

    await expect(page.getByRole('alert')).toHaveText(t('helpCenter:refusals.schedule-in-past'));
  });

  test('makes a version internal from the panel', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openHelpCenter(page, locale);
    await page.getByRole('link', { name: TIMELINES[locale] }).first().click();

    const internal = page.getByRole('radio', { name: t('helpCenter:panel.visibility.internal') });
    await internal.click();
    await expect(page.getByText(t('helpCenter:toast.visibility.internal'))).toBeVisible();
    await expect(internal).toBeChecked();
  });
});

test.describe('Who can read it', () => {
  test('switches the help center to internal only', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openHelpCenter(page, locale);
    await page.getByRole('tab', { name: t('helpCenter:tabs.settings') }).click();

    await page
      .getByRole('radio', { name: new RegExp(t('helpCenter:settings.access.internal_only.label')) })
      .check();
    await page
      .getByRole('region', { name: t('helpCenter:settings.heading') })
      .getByRole('button', { name: t('helpCenter:settings.save') })
      .click();

    await expect(page.getByText(t('helpCenter:settings.saved'))).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
});
