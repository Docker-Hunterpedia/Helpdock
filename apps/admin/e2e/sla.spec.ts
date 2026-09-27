import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { openTicket, openTicketing, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M3-01 and M3-02 in the admin, in a real browser and both languages: the
 * Ticketing › Business hours tab (`AdminTicketingBusinessHours`), the SLAs tab
 * (`AdminTicketingSLAs`), and the DetailsPanel SLA card (`AdminTicketSLA`).
 *
 * Every step navigates by clicking, never by `page.goto`: the fixture keeps
 * its session and its data in memory, and a reload would lose both.
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

const openTab = async (page: Page, locale: 'en' | 'ar', tab: 'businessHours' | 'slas') => {
  const t = strings(locale);
  await openTicketing(page, locale);
  await page.getByRole('tab', { name: t(`ticketing:tabs.${tab}`) }).click();
  if (tab === 'businessHours') {
    await page
      .getByRole('heading', { name: t('ticketing:businessHours.heading'), level: 2 })
      .waitFor();
  } else {
    await page.getByRole('form', { name: t('ticketing:slas.editor.form') }).waitFor();
  }
};

const billing = (locale: 'en' | 'ar'): string => (locale === 'ar' ? 'الفوترة' : 'Billing');

test.describe('the Business hours tab', () => {
  // The two zone pickers list every IANA zone, and axe reads all of them.
  test.describe.configure({ timeout: 120_000 });

  test('gives a department its own hours and saves', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTab(page, locale, 'businessHours');

    await expect(
      page.getByRole('switch', {
        name: t('ticketing:businessHours.weekly.dayOpen', {
          day: t('ticketing:businessHours.days.sunday'),
        }),
      }),
    ).toBeChecked();
    expect(await violations(page)).toEqual([]);

    await page
      .getByRole('button', {
        name: t('ticketing:businessHours.departments.overrideFor', { name: billing(locale) }),
      })
      .click();
    await page
      .getByRole('radio', { name: t('ticketing:businessHours.departments.useOwn') })
      .check();
    expect(await violations(page)).toEqual([]);
    await page.getByRole('button', { name: t('ticketing:businessHours.footer.save') }).click();

    await expect(page.getByRole('status')).toContainText(t('ticketing:toast.businessHoursSaved'));
  });

  test('refuses a range that ends before it starts', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTab(page, locale, 'businessHours');
    const saturday = t('ticketing:businessHours.days.saturday');

    await page
      .getByRole('switch', { name: t('ticketing:businessHours.weekly.dayOpen', { day: saturday }) })
      .check();
    await page
      .getByLabel(t('ticketing:businessHours.weekly.closes', { day: saturday }))
      .first()
      .fill('08:00');

    await expect(page.getByText(t('ticketing:businessHours.weekly.backwards'))).toBeVisible();
    await expect(
      page.getByRole('button', { name: t('ticketing:businessHours.footer.save') }),
    ).toBeDisabled();
  });

  test('adds a holiday', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTab(page, locale, 'businessHours');

    const form = page.getByRole('form', { name: t('ticketing:businessHours.holidays.form') });
    await form.getByLabel(new RegExp(`^${t('ticketing:businessHours.holidays.name')}`)).fill('Eid');
    await form.getByRole('button', { name: t('ticketing:businessHours.holidays.add') }).click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.holidayAdded', { name: 'Eid' }),
    );
  });
});

test.describe('the SLAs tab', () => {
  test('changes a target and saves the policy', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTab(page, locale, 'slas');
    expect(await violations(page)).toEqual([]);

    const editor = page.getByRole('form', { name: t('ticketing:slas.editor.form') });
    await editor
      .getByLabel(
        t('ticketing:slas.editor.targetLabel', {
          clock: t('ticketing:slas.editor.firstResponse'),
          priority: t('tickets:priority.high'),
        }),
      )
      .fill('2');
    await editor.getByRole('button', { name: t('ticketing:slas.editor.save') }).click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.policySaved', { name: 'Onboarding on-call' }),
    );
  });

  test('refuses a target of 0', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTab(page, locale, 'slas');

    const editor = page.getByRole('form', { name: t('ticketing:slas.editor.form') });
    await editor
      .getByLabel(
        t('ticketing:slas.editor.targetLabel', {
          clock: t('ticketing:slas.editor.resolution'),
          priority: t('tickets:priority.low'),
        }),
      )
      .fill('0');

    await expect(editor.getByText(t('ticketing:slas.editor.targetMissing'))).toBeVisible();
    await expect(editor.getByText(t('ticketing:slas.editor.issues', { count: 1 }))).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
});

test.describe('the SLA card', () => {
  test('shows the policy and the breached clock on a ticket', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    const card = page.getByRole('region', {
      name: t('tickets:slaCard.headingPolicy', { policy: 'Support and Billing' }),
    });
    await expect(card).toBeVisible();
    await expect(card.getByText(t('tickets:slaCard.clock.first_response'))).toBeVisible();
    await expect(card.getByRole('progressbar')).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
});
