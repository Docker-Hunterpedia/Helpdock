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
  const ordered = await rows.allTextContents();
  await sort.click();
  await expect(
    page.getByRole('menuitemradio', { name: new RegExp(t('tickets:sort.slaDue.asc')) }),
  ).toHaveAttribute('aria-checked', 'true');
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

// #353: adding Sort must not squeeze the 360 px header into wrapped controls.
test('ticket header fits its 360 px column with active filters', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTickets(page, locale);
  await page.evaluate(() => document.fonts.ready);
  const region = page.getByRole('region', { name: t('tickets:list.label') });
  expect(await region.evaluate((element) => element.getBoundingClientRect().width)).toBe(360);
  const title = region.getByRole('heading', { level: 1 });
  expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const header = title.locator('..');
  const buttons = header.getByRole('button');
  await expect(buttons).toHaveCount(3);
  for (const button of await buttons.all()) {
    expect(
      await button.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const row = element.parentElement?.parentElement?.getBoundingClientRect();
        return row !== undefined && bounds.left >= row.left && bounds.right <= row.right;
      }),
    ).toBe(true);
  }
  expect(
    await title.evaluate(
      (element) =>
        element.getBoundingClientRect().height <=
        Number.parseFloat(getComputedStyle(element).lineHeight),
    ),
  ).toBe(true);
  const sort = region.getByRole('button', { name: t('tickets:sort.action'), exact: true });
  const newTicket = region.getByRole('button', {
    name: t('tickets:newTicket.action'),
    exact: true,
  });
  expect(
    await newTicket.evaluate((element) => {
      const label = document.createRange();
      label.selectNodeContents(element);
      const text = label.getBoundingClientRect();
      const button = element.getBoundingClientRect();
      return text.width <= button.width && text.height <= button.height;
    }),
  ).toBe(true);
  const filterLabel = t('tickets:list.filterActive', { count: 4 });
  const filter = region.getByRole('button', { name: filterLabel, exact: true });
  const badge = filter.locator('span[aria-hidden="true"]');
  await expect(badge).toHaveText('4');
  await expect(badge).toHaveCSS('inset-block-start', '-6px');
  await expect(badge).toHaveCSS('inset-inline-end', '-6px');
  expect(
    await filter.evaluate((element) => {
      const badge = element.querySelector('span[aria-hidden="true"]');
      const icon = element.querySelector('svg');
      if (!badge || !icon) return false;
      const count = badge.getBoundingClientRect();
      const funnel = icon.getBoundingClientRect();
      const iconCenter = document.elementFromPoint(
        funnel.x + funnel.width / 2,
        funnel.y + funnel.height / 2,
      );
      const uncovered = iconCenter === icon || icon.contains(iconCenter);
      const visible = document.elementFromPoint(count.x + count.width / 2, count.y + 2) === badge;
      return uncovered && visible;
    }),
  ).toBe(true);
  await page.keyboard.press('Tab');
  await sort.focus();
  await expect(
    page.getByRole('tooltip', { name: t('tickets:sort.action'), exact: true }),
  ).toBeVisible();
  await expect(sort).not.toHaveAttribute('title');
  await expect(
    page.getByRole('tooltip', { name: t('tickets:sort.action'), exact: true }),
  ).toHaveCSS('pointer-events', 'none');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('tooltip')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(sort).toBeFocused();
  await expect(page.getByRole('tooltip')).toBeHidden();
  await page.keyboard.press('Tab');
  await expect(filter).toBeFocused();
  await expect(page.getByRole('tooltip', { name: filterLabel, exact: true })).toBeVisible();
  await expect(filter).not.toHaveAttribute('title');
  await expect(page.getByRole('tooltip', { name: filterLabel, exact: true })).toHaveCSS(
    'pointer-events',
    'none',
  );
  await filter.click();
  await expect(page.getByRole('region', { name: t('tickets:filters.title') })).toBeVisible();
  await expect(page.getByRole('tooltip')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(
    region.getByRole('button', { name: t('tickets:list.filterActive', { count: 4 }), exact: true }),
  ).toBeFocused();
  await expect(page.getByRole('tooltip')).toBeHidden();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(filter).toBeFocused();
  await expect(page.getByRole('tooltip', { name: filterLabel, exact: true })).toBeVisible();
  await region.getByRole('button', { name: t('tickets:newTicket.action'), exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('ticket header shows a removable Imported-only filter', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTickets(page, locale, 'all');
  await page.getByRole('button', { name: t('tickets:list.filter'), exact: true }).click();
  await page.getByRole('switch', { name: t('tickets:filters.imported'), exact: true }).click();
  await page.keyboard.press('Escape');
  const region = page.getByRole('region', { name: t('tickets:list.label') });
  const filter = region.getByRole('button', {
    name: t('tickets:list.filterActive', { count: 1 }),
    exact: true,
  });
  await expect(filter.getByText('1', { exact: true })).toHaveAttribute('aria-hidden', 'true');
  const chipLabel = t('tickets:summary.chip', {
    field: t('tickets:filters.source'),
    value: t('tickets:filters.imported'),
  });
  await region
    .getByRole('button', { name: t('tickets:viewBar.remove', { filter: chipLabel }), exact: true })
    .click();
  await expect(
    region.getByRole('button', { name: t('tickets:list.filter'), exact: true }),
  ).toBeVisible();
  await expect(
    region
      .getByRole('button', { name: t('tickets:list.filter'), exact: true })
      .locator('span[aria-hidden="true"]'),
  ).toHaveCount(0);
  await expect(page).not.toHaveURL(/imported=/);
});
