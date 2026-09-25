import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { openTicket, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M1-15 part 2 in a real browser, in both languages: the details panel's
 * Linked tickets (panel 6 of `Admin · view dialogs`) and a ticket view that
 * never scrolls sideways.
 *
 * The fixture's HD-1041 continues HD-1030 and was split from a ticket the
 * viewer cannot open, so it shows one card and one locked line.
 */

test.use({ reducedMotion: 'reduce' });

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

test.describe('linked tickets', () => {
  test('names a linked ticket by reference, status, subject and relation, and opens it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale, 'HD-1041');

    const details = page.getByRole('complementary', { name: t('tickets:details.label') });
    const linked = details.getByRole('region', { name: t('tickets:details.linked') });
    const parent = linked.getByRole('link', { name: /HD-1030/ });
    await expect(parent).toContainText(t('tickets:details.relation.parent'));
    expect(await violations(page)).toEqual([]);

    await parent.click();
    await expect(page.getByRole('region', { name: t('tickets:header.label') })).toContainText(
      'HD-1030',
    );
  });

  test('draws a ticket the viewer cannot open as the locked line and nothing that names it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale, 'HD-1041');

    const linked = page
      .getByRole('complementary', { name: t('tickets:details.label') })
      .getByRole('region', { name: t('tickets:details.linked') });
    const locked = linked
      .getByRole('listitem')
      .filter({ hasText: t('tickets:details.linkedHidden') });

    await expect(locked).toHaveText(
      `${t('tickets:details.linkedHidden')}${t('tickets:details.linkedHiddenCaption', {
        relation: t('tickets:details.relation.splitFrom'),
      })}`,
    );
    await expect(locked.getByRole('link')).toHaveCount(0);
  });
});

test.describe('the ticket view’s width', () => {
  for (const width of [1440, 1280]) {
    test(`never scrolls sideways at ${String(width)}px`, async ({ page, appLocale: locale }) => {
      await page.setViewportSize({ width, height: 900 });
      await signIn(page, locale);
      await openTicket(page, locale);

      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));

      expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
    });
  }
});
