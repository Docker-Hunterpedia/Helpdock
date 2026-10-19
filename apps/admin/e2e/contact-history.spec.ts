import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { isolate } from '../src/screens/tickets/format.js';
import { expect, test } from './fixtures.js';
import { openTicket, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * The contact card's Previous tickets (#237, `Admin/Ticket-ContactHistory`) in
 * a real browser, in both languages.
 *
 * The fixture's Mona Khalil is the returning customer: HD-1042 is open, HD-1030
 * came before it, and two more sit in departments the viewer is not in. HD-1041
 * is the only ticket of its contact, M. Khalil.
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

const previousTickets = (page: Page, locale: 'en' | 'ar') => {
  const t = strings(locale);

  return page
    .getByRole('complementary', { name: t('tickets:details.label') })
    .getByRole('region', { name: new RegExp(`^${t('tickets:details.previous')}`) });
};

test.describe('previous tickets on the contact card', () => {
  test('lists a returning customer’s earlier ticket and opens it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale, 'HD-1042');

    const section = previousTickets(page, locale);
    await expect(section.getByRole('heading')).toHaveText(`${t('tickets:details.previous')} · 1`);
    const earlier = section.getByRole('link', { name: /HD-1030/ });
    await expect(earlier).toContainText('Duplicate charge on the September invoice');
    await expect(earlier).toContainText(locale === 'ar' ? 'مغلقة' : 'Closed');
    // The open ticket is not its own history.
    await expect(section.getByRole('link', { name: /HD-1042/ })).toHaveCount(0);
    await expect(section).toContainText(t('tickets:details.hiddenTickets', { count: 2 }));
    expect(await violations(page)).toEqual([]);

    await earlier.click();
    await expect(page.getByRole('region', { name: t('tickets:header.label') })).toContainText(
      'HD-1030',
    );
    // Seen from HD-1030, the history is HD-1042.
    await expect(
      previousTickets(page, locale).getByRole('link', { name: /HD-1042/ }),
    ).toBeVisible();
  });

  test('goes to the contact page from the link named after the contact', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale, 'HD-1042');

    await previousTickets(page, locale)
      .getByRole('link', { name: t('tickets:details.viewAllOn', { name: isolate('Mona Khalil') }) })
      .click();

    await expect(page.getByRole('heading', { name: 'Mona Khalil', level: 1 })).toBeVisible();
  });

  test('says it is the contact’s first ticket when nothing came before it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale, 'HD-1041');

    const section = previousTickets(page, locale);
    await expect(section.getByRole('heading')).toHaveText(t('tickets:details.previous'));
    await expect(section).toContainText(t('tickets:details.firstTicket'));
    await expect(section.getByRole('link')).toHaveCount(0);
    expect(await violations(page)).toEqual([]);
  });
});
