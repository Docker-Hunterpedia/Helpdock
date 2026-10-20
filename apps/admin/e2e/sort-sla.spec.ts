import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures.js';
import { openTicketing, openTickets, signIn } from './flows.js';
import { strings } from './strings.js';

test.use({ reducedMotion: 'reduce' });

test('sorts by SLA urgency and restores focus when the menu is cancelled', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page, locale);
  await openTickets(page, locale, 'all');
  const sort = page.getByRole('button', { name: t('tickets:sort.action'), exact: true });
  await sort.click();
  await expect(page.getByText(t('tickets:sort.slaDue.hint'), { exact: true })).toBeVisible();
  const checks = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(checks.violations).toEqual([]);
  await page.getByRole('menuitemradio', { name: new RegExp(t('tickets:sort.slaDue.asc')) }).click();
  await expect(page).toHaveURL(/sort=slaDue/);
  const rows = page
    .getByRole('region', { name: t('tickets:list.label') })
    .getByRole('link', { name: /HD-/ });
  await expect(rows.first()).toContainText('HD-1028');
  await expect(rows.nth(1)).toContainText('HD-1042');
  await expect(rows.nth(2)).toContainText('HD-1035');
  await expect(rows.nth(3)).toContainText('HD-1041');
  const region = page.getByRole('region', { name: t('tickets:list.label') });
  expect(await region.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: `/private/tmp/helpdock-m14-07-validation/${locale}-sorted.png` });
  const ordered = await rows.allTextContents();
  await sort.click();
  await expect(
    page.getByRole('menuitemradio', { name: new RegExp(t('tickets:sort.slaDue.asc')) }),
  ).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: `/private/tmp/helpdock-m14-07-validation/${locale}-menu.png` });
  await page.keyboard.press('Escape');
  await expect(sort).toBeFocused();
  expect(await rows.allTextContents()).toEqual(ordered);
  await sort.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(page).not.toHaveURL(/sort=slaDue/);
  expect(errors).toEqual([]);
});

test('saves SLA due in the view editor and opens the view in that order', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicketing(page, locale);
  await page.getByRole('tab', { name: t('ticketing:tabs.views') }).click();
  await page.getByRole('button', { name: t('ticketing:views.add'), exact: true }).click();
  const card = page.getByRole('form', { name: t('ticketing:views.editor.newHeading') });
  await card
    .getByLabel(t('ticketing:views.editor.sort'), { exact: true })
    .selectOption('slaDue:asc');
  await expect(card.getByText(t('tickets:sort.slaDue.hint'), { exact: true })).toBeVisible();
  // An incomplete view cannot be saved, even after selecting a valid order.
  await expect(
    card.getByRole('button', { name: t('ticketing:views.editor.create') }),
  ).toBeDisabled();
  await card.getByLabel(t('ticketing:views.editor.name'), { exact: true }).fill('SLA urgency');
  await card.getByRole('button', { name: t('ticketing:views.editor.create') }).click();
  await page.getByRole('link', { name: /^SLA urgency/ }).click();
  const rows = page
    .getByRole('region', { name: t('tickets:list.label') })
    .getByRole('link', { name: /HD-/ });
  await expect(rows.first()).toContainText('HD-1028');
  await page.getByRole('button', { name: t('tickets:sort.action'), exact: true }).click();
  await expect(
    page.getByRole('menuitemradio', { name: new RegExp(t('tickets:sort.slaDue.asc')) }),
  ).toHaveAttribute('aria-checked', 'true');
});
