import { expect, test } from './fixtures.js';
import { clickSettingsTab, goInApp, openTicket, openTicketing, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * `Admin/Ticketing-Priorities` (M1-02) in a real browser, in both languages:
 * a rename that reaches the ticket screens without a reload, the duplicate a
 * person is stopped at, and the two old addresses that now open the page.
 *
 * The session of the fixture lives in memory, so every move after sign-in is a
 * click or a `goInApp`, never a reload.
 */

const heading = (t: ReturnType<typeof strings>) => t('ticketing:tabs.priorities');

test.describe('priority labels', () => {
  test('renames Urgent, saves, and the ticket shows the new name without a reload', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    const name = locale === 'ar' ? 'حرجة' : 'P1';
    await signIn(page, locale);
    await openTicketing(page, locale);
    await clickSettingsTab(page, t, 'ticketing:tabs.priorities');

    await expect(page.getByRole('heading', { name: heading(t), level: 1 })).toBeVisible();
    const field = page.getByRole('textbox', {
      name: t(locale === 'ar' ? 'ticketing:priorities.fieldAr' : 'ticketing:priorities.fieldEn', {
        name: t('tickets:priority.urgent'),
      }),
    });
    const save = page.getByRole('button', { name: t('ticketing:priorities.save'), exact: true });
    await expect(save).toBeDisabled();

    await field.fill(name);
    await expect(save).toBeEnabled();
    await expect(
      page.getByText(t('ticketing:priorities.defaultName', { name: t('tickets:priority.urgent') })),
    ).toBeVisible();
    await save.click();

    await expect(page.getByRole('status')).toContainText(t('ticketing:toast.prioritiesSaved'));
    await expect(save).toBeDisabled();

    await openTicket(page, locale);
    const header = page.getByRole('region', { name: t('tickets:header.label') });
    await expect(header.getByText(name, { exact: true })).toBeVisible();
    await expect(header.getByText(t('tickets:priority.urgent'), { exact: true })).toHaveCount(0);
  });

  test('stops a name another priority already has, under the field that was edited', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketing(page, locale);
    await clickSettingsTab(page, t, 'ticketing:tabs.priorities');

    const fieldKey =
      locale === 'ar' ? 'ticketing:priorities.fieldAr' : 'ticketing:priorities.fieldEn';
    const high = page.getByRole('textbox', {
      name: t(fieldKey, { name: t('tickets:priority.high') }),
    });
    await high.fill(t('tickets:priority.urgent').toLocaleUpperCase(locale === 'ar' ? 'ar' : 'en'));

    await expect(
      page.getByText(t('ticketing:priorities.duplicate', { name: t('tickets:priority.urgent') })),
    ).toBeVisible();
    await expect(high).toHaveAttribute('aria-invalid', 'true');

    await page.getByRole('button', { name: t('ticketing:priorities.save'), exact: true }).click();
    await expect(high).toBeFocused();
    await expect(page.getByRole('status')).toHaveCount(0);

    await page
      .getByRole('button', { name: t('ticketing:priorities.discard'), exact: true })
      .click();
    await expect(high).toHaveValue('');
  });

  for (const address of ['/settings/inbox/priorities', '/admin/ticketing/priorities']) {
    test(`opens the page at ${address}`, async ({ page, appLocale: locale }) => {
      const t = strings(locale);
      await signIn(page, locale);
      await goInApp(page, address);

      await expect(page.getByRole('heading', { name: heading(t), level: 1 })).toBeVisible();
      await expect(page).toHaveURL(/\/settings\/inbox\/priorities$/);
      await expect(page.getByRole('form', { name: t('ticketing:priorities.form') })).toBeVisible();
    });
  }
});
