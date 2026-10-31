import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { openTickets, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M14-22 in a real browser, in both languages (`Admin/Tickets-Narrow`): below
 * 1024 px the list is the screen, a ticket is pushed over it with a back
 * button, the details are a drawer, and returning lands on the same scroll
 * position.
 */

test.use({ reducedMotion: 'reduce' });

const WIDTH = 768;

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

/** Signed in and on "All tickets" at the artboard width, then narrowed: the sidebar is a drawer below 1024 px. */
const open = async (page: Page, locale: 'en' | 'ar', height = 720) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTickets(page, locale, 'all');
  await page.setViewportSize({ width: WIDTH, height });

  const list = page.getByRole('region', { name: t('tickets:list.label') });
  const back = page.getByRole('button', {
    name: t('tickets:narrow.back', { view: t('tickets:views.all') }),
  });
  const header = page.getByRole('region', { name: t('tickets:header.label') });
  const scroller = (): Locator => list.locator('[aria-busy]');
  // The list is remounted as the window narrows; wait for it to fill the screen.
  await expect.poll(async () => (await list.boundingBox())?.width ?? 0).toBeGreaterThan(WIDTH - 2);

  return { t, list, back, header, scroller };
};

test.describe('the ticket workspace at 768 px', () => {
  test('fills the screen with the list and passes axe', async ({ page, appLocale: locale }) => {
    const { t, list } = await open(page, locale);

    await expect(list).toBeVisible();
    await expect(page.getByText(t('tickets:empty.noSelectionHeading'))).toHaveCount(0);
    await expect(page.getByRole('button', { name: t('tickets:list.open') })).toHaveCount(0);

    expect(await violations(page)).toEqual([]);
  });

  test('pushes the ticket, with a back button that mirrors in Arabic, and passes axe', async ({
    page,
    appLocale: locale,
  }) => {
    const { list, back, header } = await open(page, locale);
    await page.getByRole('link', { name: /HD-1042/ }).click();

    await expect(header).toBeVisible();
    await expect(list).toBeHidden();
    await expect(page).toHaveURL(/\/tickets\/[^/?]+/);
    await expect(back.locator('.mirror-in-rtl')).toHaveCSS(
      'transform',
      locale === 'ar' ? 'matrix(-1, 0, 0, 1, 0, 0)' : 'none',
    );
    expect(await violations(page)).toEqual([]);

    await back.click();
    await expect(list).toBeVisible();
    await expect(header).toBeHidden();
    await expect(page).toHaveURL(/\/tickets(\?|$)/);
  });

  test('returns to the same scroll position from the back button and from the browser', async ({
    page,
    appLocale: locale,
  }) => {
    const { list, back, header, scroller } = await open(page, locale, 420);
    await expect(page.getByRole('link', { name: /HD-1035/ })).toBeAttached();

    // Playwright scrolls a target into view before it clicks, so the position
    // is read once that has happened.
    const last = page.getByRole('link', { name: /HD-1035/ });
    await last.scrollIntoViewIfNeeded();
    const bottom = await scroller().evaluate((node) => node.scrollTop);
    expect(bottom).toBeGreaterThan(0);

    await last.click();
    await expect(header).toBeVisible();
    await back.click();
    await expect(list).toBeVisible();
    expect(await scroller().evaluate((node) => node.scrollTop)).toBe(bottom);

    await last.click();
    await expect(header).toBeVisible();
    await page.goBack();
    await expect(list).toBeVisible();
    expect(await scroller().evaluate((node) => node.scrollTop)).toBe(bottom);
  });

  test('opens the details as a drawer from the bar, and Esc closes it', async ({
    page,
    appLocale: locale,
  }) => {
    const { t, header } = await open(page, locale);
    await page.getByRole('link', { name: /HD-1042/ }).click();
    await expect(header).toBeVisible();

    const details = page.getByRole('complementary', { name: t('tickets:details.label') });
    await expect(details).toBeHidden();
    // One Details button, in the bar: the header does not repeat it.
    await expect(page.getByRole('button', { name: t('tickets:header.details') })).toHaveCount(1);

    await page.getByRole('button', { name: t('tickets:header.details') }).click();
    await expect(details).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(details).toBeHidden();
  });

  test('ticks rows and shows the bulk bar on the list', async ({ page, appLocale: locale }) => {
    const { t } = await open(page, locale);

    await page
      .getByRole('checkbox', { name: t('tickets:bulk.selectRow', { reference: 'HD-1042' }) })
      .click();
    await expect(page.getByRole('toolbar', { name: t('tickets:bulk.bar.label') })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('toolbar', { name: t('tickets:bulk.bar.label') })).toHaveCount(0);
  });

  test('answers j, k and Enter, and leaves [ alone', async ({ page, appLocale: locale }) => {
    const { t, list, header, back } = await open(page, locale);
    const reference = header.locator('p').first();

    await page.keyboard.press('[');
    await expect(list).toBeVisible();
    await expect(page.getByRole('button', { name: t('tickets:list.open') })).toHaveCount(0);

    const shown = async (): Promise<string> =>
      (await reference.textContent({ timeout: 1000 }).catch(() => null)) ?? '';
    await page.keyboard.press('j');
    await expect.poll(shown).toMatch(/HD-/);
    const first = await shown();
    await page.keyboard.press('j');
    await expect.poll(shown).toMatch(/HD-/);
    await expect.poll(shown).not.toBe(first);
    const second = await shown();
    await page.keyboard.press('k');
    await expect.poll(shown).toBe(first);
    await page.keyboard.press('j');
    await expect.poll(shown).toBe(second);

    await back.click();
    await expect(list).toBeVisible();
    // Focus is on the row of the ticket last open (not the first), and Enter follows its link.
    const row = page.getByRole('link', { name: new RegExp(second ?? '') });
    await expect(row).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(header).toBeVisible();
  });

  test('falls back to the search box when the row it opened from is not loaded', async ({
    page,
    appLocale: locale,
  }) => {
    const { t, list, header } = await open(page, locale);
    await page.getByRole('link', { name: /HD-1042/ }).click();
    await expect(header).toBeVisible();
    // A link to the ticket under a search that does not list it, as a deep link has.
    await page.evaluate((view) => {
      window.history.pushState({}, '', `${window.location.pathname}?view=${view}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, '0192c3f0-1a2b-7c3d-8e4f-0000000000e2');
    await expect(header).toBeVisible();
    await page
      .getByRole('button', {
        name: t('tickets:narrow.back', { view: t('tickets:views.unassigned') }),
      })
      .click();
    await expect(list).toBeVisible();
    await expect(
      page.getByRole('searchbox', { name: t('tickets:list.searchLabel') }),
    ).toBeFocused();
  });
});
