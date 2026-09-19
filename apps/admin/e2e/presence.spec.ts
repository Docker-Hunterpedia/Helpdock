import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import { MOCK_USER } from '../src/auth/mock-api.js';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M0-13 in the browser: the footer shows the status in words and in colour, and
 * the account menu is where a person sets themselves away.
 *
 * The socket is `MockRealtimeClient`, chosen by the same `VITE_AUTH_API=mock`
 * switch as the auth fixture (`realtime/select-client.ts`), so this suite needs
 * no server and still drives the real provider, the real reducer and the real
 * component.
 */

const accountMenu = (page: Page, locale: Locale) =>
  page.getByRole('button', {
    name: strings(locale)('admin:currentUser.menuLabel', { name: MOCK_USER.name }),
  });

test.describe('presence', () => {
  test('shows the status in words beside the dot, and toggles it from the menu', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);

    const footer = accountMenu(page, locale);
    const dot = footer.locator('[data-status]');

    await expect(footer).toContainText(t('admin:presence.status.online'));
    await expect(dot).toHaveAttribute('data-status', 'online');
    // DESIGN §10: the dot is decoration; the words carry the meaning.
    await expect(dot).toHaveAttribute('aria-hidden', 'true');

    await footer.click();
    await page.getByRole('menuitem', { name: t('admin:presence.setAway') }).click();

    await expect(footer).toContainText(t('admin:presence.status.away'));
    await expect(dot).toHaveAttribute('data-status', 'away');

    await footer.click();
    await page.getByRole('menuitem', { name: t('admin:presence.setOnline') }).click();

    await expect(footer).toContainText(t('admin:presence.status.online'));
    await expect(dot).toHaveAttribute('data-status', 'online');
  });
});
