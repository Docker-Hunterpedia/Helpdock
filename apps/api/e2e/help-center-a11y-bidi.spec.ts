import { expect, type Page } from '@playwright/test';
import { ARTICLES } from '../src/testing/help-center-site.ts';
import { HELP_CENTER_URL, HELP_CENTER_WALL_URL } from './fixtures.ts';
import { FALLBACK_ARTICLE, PAGES, path, test } from './help-center-pages.ts';

/**
 * Mixed-direction text on the Arabic help center (M9-04, WCAG 1.3.2 Meaningful
 * Sequence and 3.1.2 Language of Parts; `docs/completed/accessibility-audit.md`).
 * An English article title in an Arabic list, or a ticket-style reference in
 * an Arabic article, is left-to-right text in a right-to-left page. It has to
 * be an isolate (`<bdi>` or `dir="ltr"`) so punctuation and digits next to it
 * land where they belong, and an English title has to say `lang="en"` so a
 * screen reader switches voice. The pages and titles are the e2e server's own
 * fixtures (`src/testing/help-center-site.ts`).
 */

test.use({ reducedMotion: 'reduce', baseURL: HELP_CENTER_URL });

/** The English title of a fixture article, which an Arabic reader meets when the article has no Arabic version (or a search hit is in English). */
const englishTitle = (slug: string): string => {
  const title = ARTICLES.find((article) => article.slug === slug)?.versions.find(
    (version) => version.locale === 'en',
  )?.title;
  if (title === undefined) {
    throw new Error(`no English article ${slug} in the fixtures`);
  }
  return title;
};

const START_A_RETURN = englishTitle('how-to-start-a-return');

/** The Arabic pages that list or show an English title: it is an article with no Arabic version, or the search stand-in's hit. */
const PAGES_WITH_ENGLISH_TITLES = [
  ['category', '/ar/categories/returns-and-refunds', START_A_RETURN],
  ['section', '/ar/sections/starting-a-return', START_A_RETURN],
  ['article shown in English, with its side links', FALLBACK_ARTICLE, START_A_RETURN],
  ['archived article, suggestions', '/ar/articles/returning-sale-items', START_A_RETURN],
  ['search results', '/ar/search?q=refund', englishTitle('refund-timelines')],
] as const;

interface Reading {
  readonly found: number;
  readonly unmarked: string[];
}

/**
 * Every place on the page where the title is written out (the innermost
 * element whose whole text it is, so a `<mark>` inside it does not hide it),
 * and what is wrong with each: is the text in English, and left to right?
 * "Left to right" is the nearest `dir` saying `ltr`, or a `<bdi>` around it.
 */
function readTitle(page: Page, title: string): Promise<Reading> {
  return page.evaluate((expected) => {
    const whole = (element: Element) => (element.textContent ?? '').trim() === expected;
    const places = [...document.querySelectorAll('main *')].filter(
      (element) => whole(element) && [...element.children].every((child) => !whole(child)),
    );
    const unmarked: string[] = [];
    for (const place of places) {
      const where = `"${expected}" in <${place.tagName.toLowerCase()}${place.className ? ` class="${place.className}"` : ''}>`;
      const language = place.closest('[lang]')?.getAttribute('lang');
      if (language !== 'en') {
        unmarked.push(`${where} has lang="${language}"`);
      }
      if (place.closest('[dir]')?.getAttribute('dir') !== 'ltr' && place.closest('bdi') === null) {
        unmarked.push(`${where} is not left to right`);
      }
    }
    return { found: places.length, unmarked };
  }, title);
}

test('the link to the other language is written in that language and its direction', async ({
  page,
  pageLocale,
}) => {
  const other = pageLocale === 'ar' ? 'en' : 'ar';
  await page.goto(path(`/${pageLocale}`));

  const link = page.locator(`header a[hreflang="${other}"]`);
  await expect(link).toHaveAttribute('lang', other);
  await expect(link).toHaveAttribute('dir', other === 'ar' ? 'rtl' : 'ltr');
});

test.describe('English text on an Arabic page', () => {
  test.skip(
    ({ pageLocale }) => pageLocale !== 'ar',
    'English text is mixed-direction only on a right-to-left page',
  );

  for (const [name, rest, title] of PAGES_WITH_ENGLISH_TITLES) {
    test(`an English title on the Arabic ${name} says lang="en" and reads left to right`, async ({
      page,
    }) => {
      await page.goto(path(rest));

      const reading = await readTitle(page, title);

      expect(reading.found, `"${title}" is on the page`).toBeGreaterThan(0);
      expect(reading.unmarked).toEqual([]);
    });
  }

  test('an article shown in English to an Arabic reader is English and left to right as a whole, under an Arabic notice', async ({
    page,
  }) => {
    await page.goto(path(FALLBACK_ARTICLE));

    const article = page.locator('main article');
    await expect(article).toHaveAttribute('lang', 'en');
    await expect(article).toHaveAttribute('dir', 'ltr');
    await expect(article.getByRole('heading', { level: 1 })).toHaveText(START_A_RETURN);
    const note = page.getByRole('note');
    await expect(note).toBeVisible();
    expect(await note.evaluate((element) => element.closest('[lang]')?.getAttribute('lang'))).toBe(
      'ar',
    );
  });

  test('a ticket-style reference in an article stays left to right', async ({ page }) => {
    await page.goto(path('/ar/articles/refund-timelines'));

    const reference = await page.evaluate(() => {
      const walker = document.createTreeWalker(
        document.querySelector('main') as Node,
        NodeFilter.SHOW_TEXT,
      );
      const found: { text: string; ltr: boolean }[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const match = /[A-Z]{2,}-\d{4}-\d+/.exec(node.textContent ?? '');
        if (match && node.parentElement) {
          found.push({
            text: match[0],
            ltr:
              node.parentElement.closest('[dir]')?.getAttribute('dir') === 'ltr' ||
              node.parentElement.closest('bdi') !== null,
          });
        }
      }
      return found;
    });

    expect(reference).toEqual([{ text: 'RF-2026-004817', ltr: true }]);
  });
});

test('every page, the wall included, declares its language and direction', async ({
  page,
  pageLocale,
}) => {
  const direction = pageLocale === 'ar' ? 'rtl' : 'ltr';
  const urls = [
    ...PAGES.map(([name, rest]) => [name, path(`/${pageLocale}${rest}`)] as const),
    ...(pageLocale === 'ar' ? [['article in English', path(FALLBACK_ARTICLE)] as const] : []),
    ['internal-only wall', `${HELP_CENTER_WALL_URL}${path(`/${pageLocale}`)}`] as const,
  ];
  const wrong: string[] = [];

  for (const [name, url] of urls) {
    await page.goto(url);
    const root = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
    }));
    if (root.lang !== pageLocale || root.dir !== direction) {
      wrong.push(`${name}: lang="${root.lang}" dir="${root.dir}"`);
    }
  }

  expect(wrong).toEqual([]);
});
