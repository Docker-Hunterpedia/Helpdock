import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { openTicket, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M14-08 in the admin, in a real browser and both languages: "How it got
 * here" in the DetailsPanel (`Admin/Ticket-Routing`), on an email ticket and
 * a widget ticket, and the card when its read fails.
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

const cardOf = (page: Page, locale: 'en' | 'ar') =>
  page.getByRole('region', { name: strings(locale)('tickets:routing.heading') });

test('an email ticket: collapsed to one line, then every automatic step', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicket(page, locale, 'HD-1042');

  const card = cardOf(page, locale);
  const toggle = card.getByRole('button', { name: t('tickets:routing.heading') });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(card).toContainText('support@helpdock.test');
  await expect(card).toContainText(t('tickets:routing.by.round_robin'));
  await expect(card.getByRole('listitem')).toHaveCount(0);

  await toggle.click();

  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const steps = card.getByRole('listitem');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toContainText(t('tickets:routing.reason.entry_department.mailbox'));
  await expect(steps.nth(1)).toContainText(t('tickets:routing.by.ai_triage'));
  await expect(steps.nth(2)).toContainText(t('tickets:routing.by.round_robin'));
  expect(await violations(page)).toEqual([]);
});

test('a widget ticket: the brand’s first department, and a rule since deleted', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicket(page, locale, 'HD-1041');

  const card = cardOf(page, locale);
  await expect(card).toContainText(t('tickets:routing.summary.widget'));

  await card.getByRole('button', { name: t('tickets:routing.heading') }).click();

  const steps = card.getByRole('listitem');
  await expect(steps.nth(0)).toContainText(t('tickets:routing.arrived.widget'));
  await expect(steps.nth(0)).toContainText(t('tickets:routing.reason.brand_first_department'));
  await expect(steps.nth(1)).toContainText(t('tickets:routing.by.ruleDeleted'));
  expect(await violations(page)).toEqual([]);
});

test('says the trail could not be read, and offers to try again', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicket(page, locale, 'HD-1028');

  const card = cardOf(page, locale);
  await expect(card).toContainText(t('tickets:routing.failed'));
  await card.getByRole('button', { name: t('tickets:routing.retry') }).click();
  await expect(card).toContainText(t('tickets:routing.failed'));
  expect(await violations(page)).toEqual([]);
});
