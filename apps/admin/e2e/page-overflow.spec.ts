import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { goInApp, submitPassword, submitTotp } from './flows.js';

/**
 * The document must never scroll sideways: a table or a sticky footer wider
 * than the window used to push the page to 1738 px on a 1456 px viewport.
 */
const PAGES = [
  '/settings/account/profile',
  '/settings/account/security',
  '/settings/brand/general',
  '/settings/inbox/departments',
  '/settings/inbox/statuses',
  '/settings/inbox/views',
  '/settings/inbox/slas',
  '/settings/channels/mailboxes',
  '/settings/channels/mailboxes/new',
  '/settings/channels/outgoing',
  '/settings/channels/widget',
  '/settings/channels/web-form',
  '/settings/ai/knowledge',
  '/settings/developers/api-keys',
  '/settings/system',
  '/settings/sso',
  '/help-center/settings',
  '/reports',
  '/contacts',
];

const overflow = (page: Page): Promise<{ scroll: number; client: number }> =>
  page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));

for (const width of [1456, 1280, 1024, 390]) {
  test(`no page scrolls sideways at ${width} px`, async ({ page, appLocale: locale }) => {
    await page.setViewportSize({ width, height: 900 });
    // The navigation is a drawer on a narrow window, so wait for the page instead.
    await submitPassword(page, locale);
    await submitTotp(page, locale);
    await page.getByRole('main').waitFor();

    const wide: string[] = [];
    for (const path of PAGES) {
      await goInApp(page, path);
      await page.getByRole('main').waitFor();
      // Data loads after the shell; give the page its content before measuring.
      await page.waitForLoadState('networkidle');
      const { scroll, client } = await overflow(page);
      if (scroll > client) {
        wide.push(`${path}: ${scroll} > ${client}`);
      }
    }

    expect(wide).toEqual([]);
  });
}
