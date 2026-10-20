import AxeBuilder from '@axe-core/playwright';
import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M14-09 in a real browser, in both languages (`Admin/Automation-Routing`):
 * the Routing tab's four steps, and Test routing through a sample that
 * matches a rule, one from a blocked sender, one the department cannot take
 * because nobody is online, and a test that fails.
 *
 * The mock fixture stands for the cases the board draws; what a browser adds
 * over the unit suite is the real layout in both directions, native selects,
 * and axe.
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

/** Through the sidebar and the tab, as a person would: the fixture's session lives in memory. */
const openRouting = async (page: Page, locale: Locale): Promise<void> => {
  const t = strings(locale);
  await signIn(page, locale);
  await page.getByRole('link', { name: new RegExp(t('admin:nav.automation')) }).click();
  await page.getByRole('tab', { name: t('rules:tabs.routing'), exact: true }).click();
  await page.getByRole('heading', { name: t('rules:routing.heading') }).waitFor();
};

const result = (page: Page, locale: Locale) =>
  page
    .getByRole('heading', { name: strings(locale)('rules:routing.result.heading') })
    .locator('xpath=..');

test('explains the four steps, with the widget’s first department said plainly', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await openRouting(page, locale);

  await expect(
    page.getByRole('tab', { name: t('rules:tabs.routing'), exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  const steps = page.getByRole('list').filter({ hasText: 'billing@helpdock.com' }).first();
  await expect(steps).toContainText('billing@helpdock.com');
  await expect(
    page.getByRole('link', { name: t('rules:routing.entry.widget'), exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      t('rules:routing.department.firstOfBrand', { name: locale === 'ar' ? 'الدعم' : 'Support' }),
    ),
  ).toHaveCount(2);
  for (const step of ['arrival', 'rules', 'triage', 'assignment'] as const) {
    await expect(
      page.getByRole('heading', { name: t(`rules:routing.steps.${step}.title`) }),
    ).toBeVisible();
  }
  await expect(
    page.getByText(t('rules:routing.steps.triage.queuedBy', { name: 'Telegram to Sales' })),
  ).toBeVisible();
  await expect(page.getByText(t('rules:routing.test.body'))).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('walks a Telegram sample through a rule that matches, AI triage, the SLA and the assignment', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await openRouting(page, locale);

  await page.getByLabel(t('rules:routing.test.entry')).selectOption({
    label: t('rules:routing.test.entryOption.telegram_bot', { label: '@helpdock_bot' }),
  });
  await page.getByLabel(t('rules:routing.test.from'), { exact: true }).fill('700100200');
  await expect(page.getByLabel(t('rules:routing.test.subject'))).toHaveCount(0);
  await page.getByLabel(t('rules:routing.test.message')).fill('Hello');
  await page.getByRole('button', { name: t('rules:routing.test.run') }).click();

  const outcome = result(page, locale);
  await expect(
    outcome.getByText(t('rules:routing.result.ruleMatches', { name: 'Telegram to Sales' })),
  ).toBeVisible();
  await expect(outcome.getByText(t('rules:routing.result.triage.queued'))).toBeVisible();
  await expect(
    outcome.getByText(t('rules:routing.result.sla.title', { policy: 'Standard' })),
  ).toBeVisible();
  await expect(outcome.getByText(t('rules:routing.result.assign.manual.title'))).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('names the condition that kept a rule from matching, and who the rotation would pick', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await openRouting(page, locale);

  await page.getByLabel(t('rules:routing.test.from'), { exact: true }).fill('mona.k@example.com');
  await page.getByLabel(t('rules:routing.test.subject')).fill('Refund for invoice 2207');
  await page.getByRole('button', { name: t('rules:routing.test.run') }).click();

  const outcome = result(page, locale);
  await expect(
    outcome.getByText(t('rules:routing.result.ruleSkips', { name: 'Refunds to Billing' })),
  ).toBeVisible();
  await expect(
    outcome.getByText(t('rules:routing.result.contactMatched.title', { name: 'Mona K.' })),
  ).toBeVisible();
  await expect(
    outcome.getByText(t('rules:routing.result.assign.picked.title', { name: 'Omar Aziz' })),
  ).toBeVisible();
});

test('stops at a blocked sender and says nothing would be created', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await openRouting(page, locale);

  await page.getByLabel(t('rules:routing.test.from'), { exact: true }).fill('rana@globex.com');
  await page.getByRole('button', { name: t('rules:routing.test.run') }).click();

  const banner = page.getByRole('status').filter({ hasText: 'rana@globex.com' });
  await expect(banner).toContainText(
    t('rules:routing.result.blocked', { from: 'rana@globex.com' }),
  );
  await expect(page.getByText(t('rules:routing.result.triage.queued'))).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
});

test('says when nobody in the department is online', async ({ page, appLocale: locale }) => {
  const t = strings(locale);
  await openRouting(page, locale);

  await page.getByLabel(t('rules:routing.test.from'), { exact: true }).fill('away@globex.com');
  await page.getByRole('button', { name: t('rules:routing.test.run') }).click();

  const outcome = result(page, locale);
  await expect(
    outcome.getByText(
      t('rules:routing.result.assign.nobodyOnline.title', {
        department: locale === 'ar' ? 'الفوترة' : 'Billing',
      }),
    ),
  ).toBeVisible();
  await expect(outcome.getByText(t('rules:routing.result.assign.nobodyOnline.body'))).toBeVisible();
});

test('says the test could not run, and keeps what was typed', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await openRouting(page, locale);

  const from = page.getByLabel(t('rules:routing.test.from'), { exact: true });
  await from.fill('fail@globex.com');
  await page.getByRole('button', { name: t('rules:routing.test.run') }).click();

  await expect(
    page.getByRole('alert').filter({ hasText: t('rules:routing.test.failed') }),
  ).toBeVisible();
  await expect(from).toHaveValue('fail@globex.com');
  await expect(page.getByRole('heading', { name: t('rules:routing.result.heading') })).toHaveCount(
    0,
  );
});
