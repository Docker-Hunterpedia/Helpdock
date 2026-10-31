import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { openTicket, openTickets, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M14-20 in a real browser, in both languages (`Admin/TicketRow-360`,
 * `Admin/Ticket-Details-Order`): the row's meta line, the assignee Avatar or
 * the dashed ring, the status left out in a one-status view, the details panel
 * in its new order with the labels above the selects, and Participants folded
 * to one line. The rules are unit-tested (`ticket-row.test.tsx`,
 * `single-status.test.ts`, `details-panel-order.test.tsx`).
 */

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

const top = async (locator: Locator): Promise<number> => {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();

  return box?.y ?? 0;
};

test('a row says status, SLA and assignee in its link, and ends in an avatar or a ring', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTickets(page, locale, 'all');

  const links = page.locator('li[data-ticket-id] a');
  const count = await links.count();
  expect(count).toBeGreaterThanOrEqual(5);

  // Every row ends in a word for who has it: a name, or "Unassigned".
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    names.push((await links.nth(index).getAttribute('aria-label')) ?? '');
    const text = (await links.nth(index).innerText()) + (await links.nth(index).textContent());
    expect(text).toMatch(
      new RegExp(
        `${t('tickets:list.unassigned')}|${t('tickets:list.assigned')}|${t('tickets:list.assignedTo', { name: '' }).trim()}`,
      ),
    );
  }
  // The link is named by its content, never by an aria-label.
  expect(names.every((name) => name === '')).toBe(true);

  const refund = page.locator('li[data-ticket-id]').filter({ hasText: 'HD-1042' }).locator('a');
  await expect(refund).toContainText(t('tickets:list.priority', { priority: '' }).trim());
  expect(await violations(page)).toEqual([]);
});

test('a one-status view leaves the status word out of its rows', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  const escalated = locale === 'ar' ? 'مُصعَّدة' : 'Escalated';
  const open = locale === 'ar' ? 'مفتوحة' : 'Open';
  await signIn(page, locale);
  await openTickets(page, locale, 'all');

  const refund = page.locator('li[data-ticket-id]').filter({ hasText: 'HD-1042' }).locator('a');
  await expect(refund).toContainText(open);

  await page.getByRole('button', { name: t('tickets:list.filter') }).click();
  await page.getByRole('switch', { name: escalated }).last().click();
  await page.keyboard.press('Escape');

  const rows = page.locator('li[data-ticket-id]');
  await expect(rows.first()).toBeVisible();
  await expect(refund).toHaveCount(0);
  for (const text of await rows.allInnerTexts()) {
    expect(text).not.toContain(escalated);
  }

  // A search names a ticket outside the view's filters (#221): that row is not
  // an Escalated one, so it keeps its own status word.
  await page.getByLabel(t('tickets:list.searchLabel')).fill('HD-1042');
  await expect(refund).toContainText(open);
});

test('the details panel runs in order, with the labels above the selects', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicket(page, locale);

  const panel = page.getByRole('complementary', { name: t('tickets:details.label') });
  const caption = (key: 'assignee' | 'status' | 'priority' | 'department' | 'tags') =>
    panel.getByText(t(`tickets:details.${key}`), { exact: true }).first();

  const ys = [
    await top(panel.getByRole('heading', { name: t('tickets:details.contact') })),
    await top(caption('assignee')),
    await top(caption('status')),
    await top(caption('priority')),
    await top(caption('department')),
    await top(caption('tags')),
    await top(panel.getByRole('heading', { name: t('tickets:details.custom') })),
    await top(panel.getByRole('region', { name: t('tickets:participants.title') })),
  ];
  expect([...ys].sort((a, b) => a - b)).toEqual(ys);

  // Above, not notched into the border: the caption ends before the select begins.
  for (const key of ['status', 'priority', 'department'] as const) {
    const label = await caption(key).boundingBox();
    const select = await panel
      .getByRole('combobox', { name: t(`tickets:details.${key}`), exact: true })
      .boundingBox();
    expect((label?.y ?? 0) + (label?.height ?? 0)).toBeLessThanOrEqual(select?.y ?? 0);
  }
  expect(await violations(page)).toEqual([]);
});

test('Participants folds to one line and opens from it', async ({ page, appLocale: locale }) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicket(page, locale);

  const card = page.getByRole('region', { name: t('tickets:participants.title') });
  const toggle = card.getByRole('button', {
    name: t('tickets:participants.summary', { count: 2 }),
  });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(card.getByRole('textbox', { name: t('tickets:participants.addLabel') })).toHaveCount(
    0,
  );

  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(
    card.getByRole('textbox', { name: t('tickets:participants.addLabel') }),
  ).toBeVisible();
  expect(await violations(page)).toEqual([]);
});
