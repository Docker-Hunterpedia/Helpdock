import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { MOCK_EMPTY_STORAGE } from '../src/auth/mock-empty.js';
import { expect, test } from './fixtures.js';
import { openContacts, openSettingsArea, settingsTab, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M14-23 (`Admin/Empty-States`), in both languages: a brand's first run on
 * Contacts, Macros, Rules and the Help center says what goes there and offers
 * the one action that fills it, and axe finds nothing on any of them.
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

/** The fixture's rows cannot all be deleted from the screen, so the run starts empty. */
const startEmpty = async (page: Page): Promise<void> => {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key as string, value as string);
    },
    [MOCK_EMPTY_STORAGE, JSON.stringify(['contacts', 'macros', 'rules', 'helpCenter'])],
  );
};

test.describe('first-run empty states', () => {
  test('Contacts offers Add contact and it opens the new-contact dialog', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await startEmpty(page);
    await signIn(page, locale);
    await openContacts(page, locale);

    await expect(page.getByRole('heading', { name: t('contacts:empty.heading') })).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await page.getByRole('button', { name: t('contacts:empty.action') }).click();
    await expect(
      page.getByRole('dialog', { name: t('contacts:dialog.createTitle') }),
    ).toBeVisible();
  });

  test('Macros offers a new saved reply and it opens the editor', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await startEmpty(page);
    await signIn(page, locale);
    await openSettingsArea(page, t, 'automation');
    await settingsTab(page, t, 'rules:tabs.macros').click();

    await expect(page.getByRole('heading', { name: t('macros:list.empty.heading') })).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await page.getByRole('button', { name: t('macros:list.empty.action') }).click();
    await expect(page.getByRole('form')).toBeVisible();
  });

  test('Rules offers a new rule and it opens the builder', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await startEmpty(page);
    await signIn(page, locale);
    await openSettingsArea(page, t, 'automation');

    await expect(
      page.getByRole('heading', { name: t('rules:list.rules.emptyHeading') }),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await page
      .getByRole('link', { name: t('rules:newRule') })
      .last()
      .click();
    await expect(page).toHaveURL(/\/rules\/new\?kind=event$/);
  });

  test('the Help center starts with a category and the button names one', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await startEmpty(page);
    await signIn(page, locale);
    await page.getByRole('link', { name: new RegExp(t('admin:nav.helpCenter')) }).click();

    await expect(
      page.getByRole('heading', { name: t('helpCenter:emptyCategories.heading') }),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await page.getByRole('button', { name: t('helpCenter:emptyCategories.action') }).click();
    await expect(
      page.getByRole('dialog', { name: t('helpCenter:tree.dialog.category') }),
    ).toBeVisible();
  });
});
