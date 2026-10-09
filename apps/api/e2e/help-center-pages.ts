import { createI18n } from '@helpdock/i18n';
import { test as base } from '@playwright/test';

/**
 * What the help center's accessibility specs share (M9-04): the language the
 * project runs in, the catalog the pages read, and the page types a reader
 * can reach on `help-center-server.ts`.
 */

export const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';

/** The `en` or `ar` project the spec runs in (`playwright.config.ts`). */
export const test = base.extend<{ pageLocale: 'en' | 'ar' }>({
  pageLocale: ['en', { option: true }],
});

/** The `hcSite` catalog the pages are rendered from, so a spec asserts the reader's words, not ids. */
export const strings = (locale: 'en' | 'ar') => {
  const t = createI18n({ lng: locale }).getFixedT(locale, 'hcSite');
  return (key: string, options?: Record<string, unknown>): string =>
    (t as unknown as (key: string, options?: Record<string, unknown>) => string)(key, options);
};

export const path = (rest: string) => `/hc/${BRAND}${rest}`;

/** Every page type a reader can reach, by the path after the locale, and the status it answers. */
export const PAGES = [
  ['home', '', 200],
  ['category', '/categories/returns-and-refunds', 200],
  ['section', '/sections/refunds', 200],
  ['article', '/articles/refund-timelines', 200],
  ['article, comment step', '/articles/refund-timelines?feedback=no', 200],
  ['article, thanks', '/articles/refund-timelines?feedback=1', 200],
  ['search, nothing asked', '/search', 200],
  ['search, results', '/search?q=refund', 200],
  ['search, nothing found', '/search?q=warranty', 200],
  ['not found', '/articles/approving-large-refunds', 404],
  ['archived', '/articles/returning-sale-items', 410],
] as const;

/** An article only the default language has: the Arabic reader gets it in English, with a notice. */
export const FALLBACK_ARTICLE = '/ar/articles/how-to-start-a-return';
