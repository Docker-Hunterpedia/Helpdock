import { createI18n } from '@helpdock/i18n';
import { test as base, type Page } from '@playwright/test';

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

export interface PageStop {
  readonly name: string;
  /** Where the element is in the document, so a stop met twice is the cycle closing. */
  readonly index: number;
  readonly ring: boolean;
  readonly visible: boolean;
}

/**
 * Tabs once all the way round a page, from its first stop until a stop comes
 * round again, and reports each stop's focus ring and size. `unreached` names
 * what is tabbable and never had focus (the video player's frame is out of
 * scope: once Tab is inside it, the ring is the provider's own).
 */
export async function tabCycle(page: Page): Promise<{ stops: PageStop[]; unreached: string[] }> {
  const stops: PageStop[] = [];
  const seen = new Set<number>();
  let last = -1;
  for (let presses = 0; presses < 150; presses += 1) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active === null || active === document.body) {
        return null;
      }
      const drawn = (element: Element | null) => {
        if (element === null) {
          return false;
        }
        const style = getComputedStyle(element);
        return style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2;
      };
      const box = active.getBoundingClientRect();
      return {
        index: [...document.querySelectorAll('*')].indexOf(active),
        name: `${active.tagName.toLowerCase()} ${(active.getAttribute('aria-label') ?? active.textContent ?? '').trim().slice(0, 40)}`,
        ring: drawn(active) || drawn(active.parentElement),
        visible: box.width > 1 && box.height > 1,
      };
    });
    if (stop === null || stop.index === last) {
      // Focus left the page, or is still inside the same frame.
      last = stop?.index ?? -1;
      continue;
    }
    if (seen.has(stop.index)) {
      break;
    }
    last = stop.index;
    seen.add(stop.index);
    stops.push(stop);
  }
  const unreached = await page.evaluate(
    (reached) => {
      const visited = new Set(reached);
      const all = [...document.querySelectorAll('*')];
      return [
        ...document.querySelectorAll<HTMLElement>(
          'a[href], button, input, textarea, select, summary, [tabindex]',
        ),
      ]
        .filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(':disabled, iframe, input[type=hidden]') &&
            element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== 'hidden' &&
            !visited.has(all.indexOf(element)),
        )
        .map(
          (element) =>
            `${element.tagName.toLowerCase()} ${(element.textContent ?? '').trim().slice(0, 40)}`,
        );
    },
    [...seen],
  );
  return { stops, unreached };
}

/** Every icon on the page and what stops it from being drawn in the text colour. */
export function iconProblems(page: Page): Promise<{ count: number; problems: string[] }> {
  return page.evaluate(() => {
    const icons = [...document.querySelectorAll<SVGElement>('main svg, header svg, footer svg')];
    const problems: string[] = [];
    for (const icon of icons) {
      const style = getComputedStyle(icon);
      const box = icon.getBoundingClientRect();
      const why: string[] = [];
      if (style.display === 'none') {
        why.push('display: none');
      }
      if (style.visibility !== 'visible' || Number(style.opacity) === 0) {
        why.push('invisible');
      }
      if (box.width < 8 || box.height < 8) {
        why.push(`${box.width} x ${box.height} px`);
      }
      if (icon.querySelectorAll('path, circle, rect, line, polyline, polygon').length === 0) {
        why.push('nothing drawn');
      }
      if (icon.getAttribute('stroke') !== 'currentColor') {
        why.push(`stroke="${icon.getAttribute('stroke')}"`);
      }
      if (style.stroke !== style.color) {
        why.push(`stroke ${style.stroke} is not the text colour ${style.color}`);
      }
      if (why.length > 0) {
        const owner = icon.parentElement;
        problems.push(
          `icon in ${owner?.className.split(' ')[0] || owner?.tagName.toLowerCase()} "${(owner?.textContent ?? '').trim().slice(0, 24)}": ${why.join(', ')}`,
        );
      }
    }
    return { count: icons.length, problems };
  });
}
