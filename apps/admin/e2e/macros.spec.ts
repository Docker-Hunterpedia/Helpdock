import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { openTicket, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * Macros and canned responses in a real browser, in both languages (M3-06):
 * the Macros tab of Automation (`AdminAutomationMacros`) and the composer's
 * picker (`AdminComposerMacros`).
 *
 * What a browser adds over the unit suite is a caret that really moves when a
 * placeholder is inserted, a picker driven by the keyboard alone, an Arabic
 * layout, and axe over each.
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

/** Through the nav and the tab row, since a reload would sign the fixture out. */
const openMacros = async (page: Page, locale: 'en' | 'ar'): Promise<void> => {
  const t = strings(locale);
  await page.getByRole('link', { name: new RegExp(t('admin:nav.automation')) }).click();
  await page.getByRole('tab', { name: t('rules:tabs.macros') }).click();
  await page.getByRole('heading', { name: t('macros:list.heading') }).waitFor();
};

test.describe('the Macros tab', () => {
  test('lists the brand’s items and opens one in the editor', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openMacros(page, locale);

    await page.getByRole('button', { name: /Refund issued/ }).click();
    const form = page.getByRole('form', { name: 'Refund issued' });
    await expect(
      form.getByRole('combobox', {
        name: t('macros:actions.type', { position: 3 }),
        exact: true,
      }),
    ).toBeVisible();
    // The reader's language picks the preview, since this macro has both.
    await expect(form.getByText(t(`macros:editor.preview.${locale}`))).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('inserts a placeholder at the caret with the keyboard alone', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openMacros(page, locale);
    await page.getByRole('button', { name: /Ask for the order number/ }).click();

    const english = page.getByLabel(t('macros:editor.reply.en'), { exact: true });
    await english.fill('Hi , thanks');
    await english.evaluate((element) => {
      (element as HTMLTextAreaElement).setSelectionRange(3, 3);
    });
    await page
      .getByRole('button', { name: t('macros:editor.placeholders.open') })
      .first()
      .click();
    await page
      .getByRole('combobox', { name: t('macros:editor.placeholders.search') })
      .fill('first');
    await page.keyboard.press('Enter');

    await expect(english).toHaveValue('Hi {{contact.first_name}}, thanks');
  });

  test('refuses to save an unfinished action and says why', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openMacros(page, locale);
    await page.getByRole('button', { name: /Close as duplicate/ }).click();

    await page.getByRole('button', { name: t('macros:actions.add') }).click();
    await page.getByRole('button', { name: t('macros:editor.save') }).click();

    await expect(page.getByRole('alert')).toHaveText(t('macros:editor.problems.actionIncomplete'));
    expect(await violations(page)).toEqual([]);
  });
});

test.describe('the composer’s macro picker', () => {
  test('applies a macro, stages its actions and sends them with the reply', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    await page.getByRole('button', { name: t('tickets:composer.canned') }).click();
    const picker = page.getByRole('dialog', { name: t('macros:picker.label') });
    await picker.getByRole('combobox', { name: t('macros:picker.search') }).fill('duplicate');
    await expect(picker.getByText(t('macros:picker.whenSent'))).toBeVisible();
    await expect(picker.locator('mark').first()).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await page.keyboard.press('Enter');

    const staged = page.getByRole('group', {
      name: t('macros:staged.label', { name: 'Close as duplicate' }),
    });
    await expect(staged).toBeVisible();
    await expect(page.getByRole('textbox', { name: t('tickets:composer.bodyLabel') })).toHaveValue(
      /we are following this up/,
    );

    await page.getByRole('button', { name: t('tickets:email.send') }).click();
    await expect(staged).toBeHidden();
    await expect(
      page.getByText(
        t('macros:event.applied', { actor: 'Lina Haddad', name: 'Close as duplicate' }),
        {
          exact: false,
        },
      ),
    ).toBeVisible();
  });

  test('closes on Esc without touching the reply', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    const body = page.getByRole('textbox', { name: t('tickets:composer.bodyLabel') });
    await body.click();
    await page.keyboard.type('/');
    await expect(page.getByRole('dialog', { name: t('macros:picker.label') })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: t('macros:picker.label') })).toBeHidden();
    await expect(body).toHaveValue('');
  });
});
