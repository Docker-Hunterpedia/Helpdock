import AxeBuilder from '@axe-core/playwright';
import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import { MOCK_EMAIL_STATE_STORAGE } from '../src/notifications/mock-api.js';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M14-11 in the browser (`Admin/Account-Notifications-Schedule`, en and ar): the
 * Email schedule card of Your account › Notifications, its Pause menu, the line
 * that says what is stopping email, and the same line at the head of the bell's
 * panel. The api is the mock adapter, whose email half a storage key presets.
 */

test.use({ reducedMotion: 'reduce' });

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) =>
      `${violation.id} (${violation.nodes.length}): ${violation.help} — ${violation.nodes
        .map((node) => node.target.join(' '))
        .join(', ')}`,
  );
}

const preset = (page: Page, state: Record<string, unknown>) =>
  page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    [MOCK_EMAIL_STATE_STORAGE, JSON.stringify(state)],
  );

const openTab = async (page: Page, locale: Locale) => {
  const t = strings(locale);
  await signIn(page, locale);
  // In the app, not by address: the mock session lives in memory, so a reload would sign out.
  await page
    .getByRole('button', {
      name: t('admin:notifications.bell.labelUnread', { count: 3 }),
      exact: true,
    })
    .click();
  await page
    .getByRole('dialog', { name: t('admin:notifications.panel.title') })
    .getByRole('link', { name: t('admin:notifications.panel.settings') })
    .click();
  const card = page.getByRole('region', { name: t('me:notifications.schedule.heading') });
  await card.waitFor();

  return card;
};

test.describe('the Email schedule card', () => {
  test('shows the four schedules, saves a daily digest at an hour, and has no axe violations', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    const card = await openTab(page, locale);

    await expect(
      card.getByRole('radio', {
        name: new RegExp(`^${t('me:notifications.schedule.options.immediate.title')}`),
      }),
    ).toBeChecked();
    await expect(card.getByText('Asia/Riyadh')).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await card.getByLabel(t('me:notifications.schedule.hour')).selectOption('17');
    await expect(
      card.getByRole('radio', {
        name: new RegExp(`^${t('me:notifications.schedule.options.daily.title')}`),
      }),
    ).toBeChecked();
    await card.getByRole('button', { name: t('me:notifications.schedule.save') }).click();

    await expect(page.getByText(t('me:notifications.schedule.saved'))).toBeVisible();
    await expect(card.getByLabel(t('me:notifications.schedule.hour'))).toHaveValue('17');
  });

  test('pauses from the menu, says until when, and resumes', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    const card = await openTab(page, locale);

    await card.getByRole('button', { name: t('me:notifications.schedule.pause') }).click();
    const menu = page.getByRole('menu', { name: t('me:notifications.schedule.pauseMenu.label') });
    await expect(menu.getByRole('menuitem')).toHaveCount(4);
    expect(await violations(page)).toEqual([]);
    await menu
      .getByRole('menuitem', { name: new RegExp(t('me:notifications.schedule.pauseMenu.oneHour')) })
      .click();

    const status = card.getByRole('status');
    await expect(status).toContainText(t('me:notifications.schedule.status.resume'));
    expect(await violations(page)).toEqual([]);

    await status
      .getByRole('button', { name: t('me:notifications.schedule.status.resume') })
      .click();
    await expect(page.getByText(t('me:notifications.schedule.toast.resumed'))).toBeVisible();
    await expect(card.getByRole('status')).toHaveCount(0);
  });

  test('says the person unsubscribed and turns email back on', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await preset(page, { unsubscribedAt: '2026-10-03T08:00:00.000Z' });
    const card = await openTab(page, locale);

    await expect(card.getByRole('status')).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await card.getByRole('button', { name: t('me:notifications.schedule.status.turnOn') }).click();

    await expect(page.getByText(t('me:notifications.schedule.toast.emailBack'))).toBeVisible();
    await expect(card.getByRole('status')).toHaveCount(0);
  });

  test('sends a test email to the person’s own address', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    const card = await openTab(page, locale);

    await card.getByRole('button', { name: t('me:notifications.schedule.testEmail') }).click();
    await expect(
      page.getByText(t('me:notifications.schedule.toast.testSent', { email: 'lina@helpdock.com' })),
    ).toBeVisible();
  });

  test('says an install without outgoing email cannot send, with the test email off', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await preset(page, { smtp: false });
    const card = await openTab(page, locale);

    await expect(card.getByRole('status')).toContainText(
      t('me:notifications.schedule.status.notConfigured'),
    );
    await expect(
      card.getByRole('button', { name: t('me:notifications.schedule.testEmail') }),
    ).toBeDisabled();
    expect(await violations(page)).toEqual([]);
  });

  test('captions the urgent kinds in the matrix', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openTab(page, locale);

    await expect(
      page.getByText(t('me:notifications.schedule.urgent'), { exact: true }),
    ).toHaveCount(3);
  });
});

test.describe('the bell’s panel', () => {
  test('heads the panel with the pause and resumes from there', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await preset(page, { pausedUntil: new Date(Date.now() + 3_600_000).toISOString() });
    await signIn(page, locale);

    await page
      .getByRole('button', {
        name: t('admin:notifications.bell.labelUnread', { count: 3 }),
        exact: true,
      })
      .click();
    const panel = page.getByRole('dialog', { name: t('admin:notifications.panel.title') });
    await expect(panel.getByRole('status')).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await panel.getByRole('button', { name: t('me:notifications.schedule.status.resume') }).click();
    await expect(panel.getByRole('status')).toHaveCount(0);
  });
});
