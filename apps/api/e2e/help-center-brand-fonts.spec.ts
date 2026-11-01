import { expect } from '@playwright/test';
import { HELP_CENTER_FONT_PORTS } from './fixtures.ts';
import { BRAND, test } from './help-center-pages.ts';

/**
 * M5-06: a brand that picks Noto Sans or Vazirmatn gets that typeface, not the
 * system fallback. The check is on the page a reader sees: the computed family
 * of the article title, and the browser having loaded a file for it from the
 * self-hosted `/_hd/fonts/`. The `en` and `ar` projects each read their own
 * language's article, so the Arabic companion is the one under test there.
 */

const EXPECTED = {
  'noto-sans': { en: 'Noto Sans', ar: 'Noto Sans Arabic' },
  vazirmatn: { en: 'Vazirmatn', ar: 'Vazirmatn' },
} as const;

for (const font of ['noto-sans', 'vazirmatn'] as const) {
  test(`a brand on ${font} reads the article in ${font}`, async ({ page, pageLocale }) => {
    const family = EXPECTED[font][pageLocale];
    const origin = `http://127.0.0.1:${String(HELP_CENTER_FONT_PORTS[font])}`;

    await page.goto(`${origin}/hc/${BRAND}/${pageLocale}/articles/refund-timelines`);

    const title = page.locator('main h1');
    await expect(title).toBeVisible();
    await expect
      .poll(() => title.evaluate((element) => getComputedStyle(element).fontFamily))
      .toMatch(new RegExp(`^"?${family}"?,`));

    // Text on screen forces the download; wait for the file rather than for a timer.
    await expect
      .poll(() =>
        page.evaluate(
          (wanted) =>
            [...document.fonts].some(
              (face) => face.family.replaceAll('"', '') === wanted && face.status === 'loaded',
            ),
          family,
        ),
      )
      .toBe(true);
  });
}
