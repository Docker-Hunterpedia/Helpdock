import type { Locale } from '@helpdock/i18n';
import { test as base, expect } from '@playwright/test';
import { LOCALE_STORAGE_KEY } from '../src/app/preferences.js';

export interface LocaleOption {
  /**
   * Which language the app starts in. Set per project, not per test. Named
   * apart from Playwright's own `locale`, which sets the browser's language;
   * the projects set both so the two agree.
   */
  appLocale: Locale;
}

/**
 * The app decides its language from `localStorage` before React mounts, so a
 * locale project seeds that key rather than relying on the browser's language.
 */
export const test = base.extend<LocaleOption>({
  appLocale: ['en', { option: true }],

  page: async ({ page, appLocale }, use) => {
    await page.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem(key as string, value as string);
      },
      [LOCALE_STORAGE_KEY, appLocale],
    );

    await use(page);
  },
});

export { expect };
