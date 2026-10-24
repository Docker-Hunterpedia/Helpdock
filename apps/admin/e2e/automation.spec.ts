import AxeBuilder from '@axe-core/playwright';
import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * `Admin/Automation` in a real browser, in both languages (M3-03 to M3-05,
 * artboards `AdminAutomationRules` and `AdminRuleBuilder`): the rule list and
 * the execution log with the loop the depth guard stopped, the builder, and a
 * test run — its happy path, and a ticket that cannot be found.
 *
 * The mock fixture is the artboard's data. What a browser adds over the unit
 * suite is the real layout in both directions, native selects, and axe.
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

/** Through the sidebar, as a person would: the fixture's session lives in memory. */
const openAutomation = async (page: Page, locale: Locale): Promise<void> => {
  const t = strings(locale);
  await signIn(page, locale);
  await page.getByRole('link', { name: new RegExp(t('admin:nav.automation')) }).click();
  await page.getByRole('list', { name: t('rules:list.rules.caption') }).waitFor();
};

const openRefundsRule = async (page: Page, locale: Locale): Promise<void> => {
  const t = strings(locale);
  await openAutomation(page, locale);
  await page.getByRole('link', { name: /^Refunds to Billing/ }).click();
  await page
    .getByRole('form', { name: t('rules:builder.formLabel', { name: 'Refunds to Billing' }) })
    .waitFor();
};

test.describe('the Rules tab', () => {
  test('lists the rules in order beside the execution log, and names the stopped loop', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openAutomation(page, locale);

    await expect(page.getByRole('heading', { name: t('rules:title'), level: 1 })).toBeVisible();
    await expect(
      page.getByRole('tab', { name: t('rules:tabs.rules'), exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    const list = page.getByRole('list', { name: t('rules:list.rules.caption') });
    await expect(list.getByRole('listitem')).toHaveCount(7);
    await expect(page.getByRole('status').filter({ hasText: 'HD-1041' })).toBeVisible();

    const log = page.getByRole('list', { name: t('rules:log.listLabel') });
    await expect(log.getByText(t('rules:log.chain.cycleTitle', { depth: 3 }))).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('turns a rule on from its switch', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openAutomation(page, locale);

    const toggle = page.getByRole('switch', {
      name: t('rules:list.enable', { name: 'Web form to Sales' }),
    });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
  });
});

test.describe('the builder and its test run', () => {
  test('shows the rule and tries it on a ticket without changing anything', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openRefundsRule(page, locale);

    await expect(page.getByRole('combobox', { name: t('rules:builder.event') })).toHaveValue(
      'ticket_created',
    );
    await expect(page.getByText(t('rules:testRun.body'))).toBeVisible();

    await page.getByLabel(t('rules:testRun.sample')).fill('HD-1042');
    await page.getByRole('button', { name: t('rules:testRun.run') }).click();

    await expect(page.getByText(t('rules:testRun.wouldRun', { ticket: 'HD-1042' }))).toBeVisible();
    await expect(
      page.getByText(t('rules:testRun.effects.doesNotCount'), { exact: true }),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('says a ticket the reader cannot see was not found', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openRefundsRule(page, locale);

    await page.getByLabel(t('rules:testRun.sample')).fill('HD-9999');
    await page.getByRole('button', { name: t('rules:testRun.run') }).click();

    await expect(page.getByRole('alert')).toHaveText(
      t('rules:testRun.notFound', { ticket: 'HD-9999', brand: 'Helpdock' }),
    );
    await expect(page.getByLabel(t('rules:testRun.sample'))).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  test('refuses to save a rule until it is complete, then saves it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openAutomation(page, locale);
    await page.getByRole('link', { name: t('rules:newRule') }).click();

    await page.getByRole('button', { name: t('rules:builder.save') }).click();
    await expect(page.getByText(t('rules:builder.incomplete'))).toBeVisible();

    await page
      .getByLabel(`${t('rules:builder.name')} · ${t('rules:builder.required')}`)
      .fill('Urgent to Technical');
    await page.getByRole('combobox', { name: t('rules:builder.field') }).selectOption('priority');
    await page.getByRole('combobox', { name: t('rules:builder.value') }).selectOption('urgent');
    await page.getByRole('combobox', { name: t('rules:fields.team') }).selectOption({
      label: 'Technical',
    });
    await page.getByRole('button', { name: t('rules:builder.save') }).click();

    await expect(
      page.getByRole('form', {
        name: t('rules:builder.formLabel', { name: 'Urgent to Technical' }),
      }),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('snoozes with the Snooze menu’s times, never the bare Snoozed status (#368)', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openAutomation(page, locale);
    await page.getByRole('link', { name: t('rules:newRule') }).click();

    const type = page.getByRole('combobox', { name: t('rules:builder.action', { n: 1 }) });
    await type.selectOption({ label: t('rules:actionTypes.snooze') });

    // The four items of the Snooze menu, which the server resolves.
    const wakeTime = page.getByRole('combobox', { name: t('rules:builder.snoozeFor') });
    await expect(wakeTime).toBeVisible();
    for (const preset of ['in_1_hour', 'in_4_hours', 'next_business_day', 'next_week'] as const) {
      await expect(
        wakeTime.locator('option', { hasText: t(`rules:builder.snoozeOption.${preset}`) }),
      ).toHaveCount(1);
    }
    await wakeTime.selectOption({ label: t('rules:builder.snoozeOption.next_business_day') });
    await expect(page.getByText(t('rules:builder.snoozeNote'))).toBeVisible();

    // Set status still cannot pick the Snoozed status: the action needs no
    // wake time, only the snooze one has it.
    await type.selectOption({ label: t('rules:actionTypes.set_status') });
    const statusPick = page.getByRole('combobox', { name: t('rules:fields.status') });
    const snoozedName = locale === 'ar' ? 'مؤجَّلة' : 'Snoozed';
    await expect(statusPick.locator('option').filter({ hasText: snoozedName })).toHaveCount(0);

    expect(await violations(page)).toEqual([]);
  });

  test('saves a rule with the snooze action and reads it back as a sentence (#368)', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openAutomation(page, locale);
    await page.getByRole('link', { name: t('rules:newRule') }).click();

    // The failure path first: an incomplete rule is refused, snooze action or not.
    await page
      .getByRole('combobox', { name: t('rules:builder.action', { n: 1 }) })
      .selectOption({ label: t('rules:actionTypes.snooze') });
    await page.getByRole('button', { name: t('rules:builder.save') }).click();
    await expect(page.getByText(t('rules:builder.incomplete'))).toBeVisible();

    await page
      .getByLabel(`${t('rules:builder.name')} · ${t('rules:builder.required')}`)
      .fill('Park awaiting tickets');
    await page.getByRole('combobox', { name: t('rules:builder.field') }).selectOption('priority');
    await page.getByRole('combobox', { name: t('rules:builder.value') }).selectOption('urgent');
    await page
      .getByRole('combobox', { name: t('rules:builder.snoozeFor') })
      .selectOption({ label: t('rules:builder.snoozeOption.next_business_day') });
    await page.getByRole('button', { name: t('rules:builder.save') }).click();
    await expect(
      page.getByRole('form', {
        name: t('rules:builder.formLabel', { name: 'Park awaiting tickets' }),
      }),
    ).toBeVisible();

    await page.getByRole('link', { name: new RegExp(t('admin:nav.automation')) }).click();
    const row = page.getByRole('listitem').filter({ hasText: 'Park awaiting tickets' });
    await expect(row).toContainText(t('rules:text.action.snooze.next_business_day'));
    expect(await violations(page)).toEqual([]);
  });
});
