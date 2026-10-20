import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { MOCK_SINGLE_KEY_STORAGE, MOCK_USER } from '../src/auth/mock-api.js';
import { MOCK_KEYBOARD_SAVE_DELAY_STORAGE } from '../src/keyboard/api.js';
import { MOCK_TICKET_REFUND } from '../src/tickets/mock-api.js';
import { expect, test } from './fixtures.js';
import { openTicket, openTickets, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M14-01 in a real browser, in both languages (`Admin/ShortcutSheet`): the
 * `?` sheet, `g` sequences and their chip, the keys on an Arabic keyboard
 * layout, and the single-key switch that turns them off.
 *
 * Playwright's keyboard types a US layout, so an Arabic layout's press is
 * dispatched as the browser would send it: the letter it types, the key it is.
 */

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

async function arabicPress(page: Page, key: string, code: string, shiftKey = false): Promise<void> {
  await page.evaluate(
    ([pressed, physical, shift]) => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: pressed as string,
          code: physical as string,
          shiftKey: shift as boolean,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    [key, code, shiftKey] as const,
  );
}

test.describe('the ? sheet', () => {
  // The dialog fades in; axe measures contrast on what is on screen.
  test.use({ reducedMotion: 'reduce' });

  test('opens on ?, lists every group, passes axe, and closes on Esc', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale, 'all');

    await page.keyboard.press('Shift+Slash');

    const sheet = page.getByRole('dialog', { name: t('tickets:keyboard.label') });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { name: t('tickets:keyboard.label') })).toBeFocused();
    for (const group of ['general', 'goTo', 'list', 'ticket', 'composer'] as const) {
      await expect(
        sheet.getByRole('heading', { level: 3, name: t(`tickets:keyboard.groups.${group}`) }),
      ).toBeVisible();
    }
    await expect(
      sheet.getByRole('switch', { name: t('tickets:keyboard.singleKey') }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(await violations(page)).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  test('opens on the Arabic ؟, which the same key types', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);

    await arabicPress(page, '؟', 'Slash', true);

    await expect(page.getByRole('dialog', { name: t('tickets:keyboard.label') })).toBeVisible();
  });
});

test.describe('the keys', () => {
  test('g then i opens My open, with the chip saying what can follow', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await page
      .getByRole('link', { name: t('admin:nav.contacts') })
      .first()
      .click();
    await page.getByRole('heading', { level: 1, name: t('contacts:title') }).waitFor();

    await page.keyboard.press('g');
    const chip = page
      .getByRole('status')
      .filter({ hasText: t('tickets:keyboard.shortcut.goTo.myOpen') });
    await expect(chip).toBeVisible();

    await page.keyboard.press('i');

    await expect(
      page.getByRole('heading', { level: 1, name: t('tickets:views.myOpen') }),
    ).toBeVisible();
    await expect(chip).toBeHidden();
  });

  test('works on an Arabic keyboard layout: j opens the next ticket, g u Unassigned', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale, 'all');
    await page.getByRole('link', { name: /HD-1042/ }).waitFor();

    await arabicPress(page, 'ت', 'KeyJ');
    await expect(page).toHaveURL(new RegExp(MOCK_TICKET_REFUND));

    await arabicPress(page, 'ل', 'KeyG');
    await arabicPress(page, 'ع', 'KeyU');
    await expect(
      page.getByRole('heading', { level: 1, name: t('tickets:views.unassigned') }),
    ).toBeVisible();
  });

  test('sends a reply with Ctrl+Enter from the composer', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);
    const body = page.getByRole('textbox', { name: t('tickets:composer.bodyLabel') });
    await body.waitFor();

    await page.keyboard.press('r');
    await expect(body).toBeFocused();
    await body.fill('Sent from the keyboard');
    await page.keyboard.press('Control+Enter');

    await expect(page.getByText(t('tickets:toast.replied'))).toBeVisible();
    await expect(body).toHaveValue('');
  });
});

test.describe('the single-key switch', () => {
  test('keeps focus on the switch through Space and the save, busy while it is out', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    // Long enough to see the save in flight, short enough not to slow the run.
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, '800');
    }, MOCK_KEYBOARD_SAVE_DELAY_STORAGE);
    await signIn(page, locale);

    await page.keyboard.press('Shift+Slash');
    const sheet = page.getByRole('dialog', { name: t('tickets:keyboard.label') });
    const toggle = sheet.getByRole('switch', { name: t('tickets:keyboard.singleKey') });
    await toggle.focus();
    await page.keyboard.press('Space');

    await expect(toggle).toHaveAttribute('aria-busy', 'true');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(toggle).toBeFocused();

    await expect(toggle).not.toHaveAttribute('aria-busy');
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  test('turned off in the sheet, no letter is a shortcut and ⌘/Ctrl ones still are', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale, 'all');
    await page.getByRole('link', { name: /HD-1042/ }).waitFor();

    await page.keyboard.press('Shift+Slash');
    const sheet = page.getByRole('dialog', { name: t('tickets:keyboard.label') });
    await sheet.getByRole('switch', { name: t('tickets:keyboard.singleKey') }).click();
    await expect(sheet.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await expect(
      sheet.getByRole('term').filter({ hasText: t('tickets:keyboard.shortcut.list.next') }),
    ).toContainText(t('tickets:keyboard.offSuffix').trim());
    await sheet.getByRole('button', { name: t('tickets:keyboard.close') }).click();
    await expect(sheet).toBeHidden();

    await page.keyboard.press('j');
    await arabicPress(page, 'ت', 'KeyJ');
    await page.keyboard.press('Shift+Slash');
    // A chord still answers. Keys are handled in order, so once it has, the
    // three presses before it have been heard and ignored.
    await page.keyboard.press('Control+Backslash');
    await expect(page.getByRole('button', { name: t('admin:nav.expand') })).toBeVisible();

    await expect(page).not.toHaveURL(new RegExp(MOCK_TICKET_REFUND));
    await expect(sheet).toBeHidden();
  });

  test('starts off when the account says so, and the account menu still opens the sheet', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, 'off');
    }, MOCK_SINGLE_KEY_STORAGE);
    await signIn(page, locale);
    await openTickets(page, locale, 'all');
    await page.getByRole('link', { name: /HD-1042/ }).waitFor();

    await page.keyboard.press('Shift+Slash');
    await page.keyboard.press('j');
    // The positive sync point, as above.
    await page.keyboard.press('Control+Backslash');
    await expect(page.getByRole('button', { name: t('admin:nav.expand') })).toBeVisible();
    const sheet = page.getByRole('dialog', { name: t('tickets:keyboard.label') });
    await expect(sheet).toBeHidden();
    await expect(page).not.toHaveURL(new RegExp(MOCK_TICKET_REFUND));

    await page
      .getByRole('button', { name: t('admin:currentUser.menuLabel', { name: MOCK_USER.name }) })
      .click();
    await page.getByRole('menuitem', { name: t('tickets:keyboard.label') }).click();
    await expect(sheet.getByRole('switch')).toHaveAttribute('aria-checked', 'false');

    await sheet.getByRole('switch').click();
    await sheet.getByRole('button', { name: t('tickets:keyboard.close') }).click();
    await page.keyboard.press('j');
    await expect(page).toHaveURL(new RegExp(MOCK_TICKET_REFUND));
  });
});
