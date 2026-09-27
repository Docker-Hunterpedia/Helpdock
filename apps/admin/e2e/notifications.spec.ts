import AxeBuilder from '@axe-core/playwright';
import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import { MOCK_PUSH_PERMISSION_STORAGE } from '../src/notifications/browser-push.js';
import { MOCK_PUSH_KEY_STORAGE } from '../src/notifications/mock-api.js';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M3-07 in the browser (artboard `AdminNotifications`): the bell in the brand
 * row, its panel, and the Notifications tab of Your account with its push card.
 *
 * The api and this browser's push half are the mock adapters, chosen by the same
 * `VITE_AUTH_API=mock` switch as the rest (`auth/select-api.ts`); two storage
 * keys the mocks read reach the failure states — a refused permission prompt,
 * and an install without VAPID keys — without a second build.
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

const bell = (page: Page, locale: Locale, unread: number) => {
  const t = strings(locale);

  return page.getByRole('button', {
    name:
      unread === 0
        ? t('admin:notifications.bell.label')
        : t('admin:notifications.bell.labelUnread', { count: unread }),
    exact: true,
  });
};

const openPanel = async (page: Page, locale: Locale, unread: number) => {
  const t = strings(locale);
  await bell(page, locale, unread).click();
  const panel = page.getByRole('dialog', { name: t('admin:notifications.panel.title') });
  await panel.waitFor();

  return panel;
};

const openNotificationsTab = async (page: Page, locale: Locale) => {
  const t = strings(locale);
  const panel = await openPanel(page, locale, 3);
  await panel.getByRole('link', { name: t('admin:notifications.panel.settings') }).click();
  await page.getByRole('heading', { name: t('me:notifications.heading') }).waitFor();
};

const setStorage = (page: Page, key: string, value: string) =>
  page.addInitScript(
    ([name, stored]) => window.localStorage.setItem(name as string, stored as string),
    [key, value],
  );

test.describe('notifications', () => {
  test('the bell counts the unread, and a row opens its ticket and is read', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);

    await expect(bell(page, locale, 3)).toContainText('3');
    const panel = await openPanel(page, locale, 3);
    expect(await violations(page)).toEqual([]);

    await expect(panel.getByText(t('admin:notifications.panel.today'))).toBeVisible();
    await panel
      .getByText(t('admin:notifications.title.mentioned', { actor: 'Omar Nasser' }))
      .click();

    await expect(page).toHaveURL(/\/tickets\/0192c3f0-1a2b-7c3d-8e4f-000000001041$/);
    await expect(bell(page, locale, 2)).toBeVisible();
  });

  test('marks everything read, and the unread filter is then empty', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);

    const panel = await openPanel(page, locale, 3);
    await panel.getByRole('button', { name: t('admin:notifications.panel.markAllRead') }).click();
    await panel.getByRole('button', { name: t('admin:notifications.panel.unreadFilter') }).click();

    await expect(panel.getByText(t('admin:notifications.panel.emptyUnread'))).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(bell(page, locale, 0)).toBeVisible();
  });

  test('saves what you are told about, and turns push on, tests it and off', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openNotificationsTab(page, locale);
    expect(await violations(page)).toEqual([]);

    const warningEmail = page.getByRole('checkbox', {
      name: t('me:notifications.cell', {
        event: t('me:notifications.kinds.sla_warning.label'),
        channel: t('me:notifications.channelNames.email'),
      }),
    });
    await expect(warningEmail).not.toBeChecked();
    await warningEmail.check();
    await page.getByRole('button', { name: t('me:notifications.save') }).click();
    await expect(page.getByText(t('me:notifications.saved'))).toBeVisible();

    await page.getByRole('button', { name: t('me:notifications.push.turnOn') }).click();
    await expect(page.getByText(t('me:notifications.push.enabled'), { exact: true })).toBeVisible();
    await page.getByRole('button', { name: t('me:notifications.push.test') }).click();
    await expect(page.getByText(t('me:notifications.push.testSent'))).toBeVisible();

    await page.getByRole('button', { name: t('me:notifications.push.turnOff') }).click();
    await expect(
      page.getByText(t('me:notifications.push.notEnabled'), { exact: true }),
    ).toBeVisible();
  });

  test('says the browser blocked push when the prompt is refused', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await setStorage(page, MOCK_PUSH_PERMISSION_STORAGE, 'denied');
    await signIn(page, locale);
    await openNotificationsTab(page, locale);

    await page.getByRole('button', { name: t('me:notifications.push.turnOn') }).click();

    await expect(page.getByText(t('me:notifications.push.blockedHeading'))).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('disables the push column on an install without VAPID keys', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await setStorage(page, MOCK_PUSH_KEY_STORAGE, 'off');
    await signIn(page, locale);
    await openNotificationsTab(page, locale);

    await expect(page.getByText(t('me:notifications.push.notSetUpHeading'))).toBeVisible();
    await expect(
      page.getByRole('checkbox', {
        name: t('me:notifications.cell', {
          event: t('me:notifications.kinds.sla_breached.label'),
          channel: t('me:notifications.channelNames.push'),
        }),
      }),
    ).toBeDisabled();
  });
});
