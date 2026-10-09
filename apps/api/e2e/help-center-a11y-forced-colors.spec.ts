import { expect, type Page } from '@playwright/test';
import { HELP_CENTER_URL, HELP_CENTER_WALL_URL } from './fixtures.ts';
import {
  FALLBACK_ARTICLE,
  iconProblems,
  PAGES,
  path,
  strings,
  tabCycle,
  test,
} from './help-center-pages.ts';

/**
 * The published help center in forced colours (Windows High Contrast; M9-04,
 * WCAG 1.4.1 and 2.4.7; `docs/completed/accessibility-audit.md`). The browser
 * drops every background, shadow and brand colour and paints the page in the
 * system's palette, so what is left must carry the meaning: the focus ring
 * (an outline stays), the pressed "No" (a thicker border, not a tint), and
 * the icons beside a note or a thanks (SVG in the text colour, which is
 * forced). Once per language, in both schemes: the system palette follows the
 * scheme.
 */

test.use({ reducedMotion: 'reduce', baseURL: HELP_CENTER_URL });

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme}, forced colours`, () => {
    test.use({ colorScheme: scheme });
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ forcedColors: 'active' });
    });

    const forced = (page: Page) =>
      page.evaluate(() => matchMedia('(forced-colors: active)').matches);

    test('every Tab stop on every page type still draws a focus ring', async ({
      page,
      pageLocale,
    }) => {
      const found: string[] = [];
      const visit = async (state: string, url: string) => {
        await page.goto(url);
        expect(await forced(page), 'the browser took forced colours').toBe(true);
        const { stops, unreached } = await tabCycle(page);
        // The skip link is the first stop of every page, so a page with no other control still has one.
        expect(stops.length, `${state}: stops`).toBeGreaterThan(1);
        for (const stop of stops.filter((one) => !one.name.startsWith('iframe'))) {
          if (!stop.ring || !stop.visible) {
            found.push(`${state}: ${stop.name} has no ring or is hidden`);
          }
        }
        for (const name of unreached) {
          found.push(`${state}: ${name} was never reached by Tab`);
        }
      };

      for (const [name, rest] of PAGES) {
        await visit(name, path(`/${pageLocale}${rest}`));
      }
      if (pageLocale === 'ar') {
        await visit('article in the default language', path(FALLBACK_ARTICLE));
      }
      await visit('internal-only wall', `${HELP_CENTER_WALL_URL}${path(`/${pageLocale}`)}`);

      expect(found).toEqual([]);
    });

    test('the pressed "No" is told from "Yes" by its border, not its colour, and says so', async ({
      page,
      pageLocale,
    }) => {
      const t = strings(pageLocale);
      await page.goto(path(`/${pageLocale}/articles/refund-timelines?feedback=no`));
      expect(await forced(page)).toBe(true);

      const edge = (name: string) =>
        page.getByRole('button', { name }).evaluate((button) => {
          const style = getComputedStyle(button);
          return {
            pressed: button.getAttribute('aria-pressed'),
            border: `${style.borderTopWidth} ${style.borderTopStyle}`,
            outline: `${style.outlineWidth} ${style.outlineStyle}`,
          };
        });
      const no = await edge(t('article.feedback.no'));
      const yes = await edge(t('article.feedback.yes'));

      expect(no.pressed).toBe('true');
      expect(yes.pressed).toBe('false');
      expect(
        { border: yes.border, outline: yes.outline },
        'the unpressed "Yes" looks like the pressed "No" once colour is gone',
      ).not.toEqual({ border: no.border, outline: no.outline });
    });

    test('the icons of the notes, the thanks, the header and the lists are drawn in the text colour', async ({
      page,
      pageLocale,
    }) => {
      const found: string[] = [];
      const pages = [
        ['home', `/${pageLocale}`],
        ['article', `/${pageLocale}/articles/refund-timelines`],
        ['article, thanks', `/${pageLocale}/articles/refund-timelines?feedback=1`],
        ['search, nothing found', `/${pageLocale}/search?q=warranty`],
        ...(pageLocale === 'ar' ? [['article, fallback notice', FALLBACK_ARTICLE]] : []),
      ] as const;

      for (const [name, rest] of pages) {
        await page.goto(path(rest));
        expect(await forced(page)).toBe(true);
        const { count, problems } = await iconProblems(page);
        if (count === 0) {
          found.push(`${name}: no icon found`);
        }
        found.push(...problems.map((problem) => `${name}: ${problem}`));
      }

      await page.goto(path(`/${pageLocale}/articles/refund-timelines?feedback=1`));
      const thanks = await page.getByRole('status').locator('svg').count();
      expect(thanks, 'the check beside the thanks').toBe(1);
      if (pageLocale === 'ar') {
        await page.goto(path(FALLBACK_ARTICLE));
        expect(
          await page.getByRole('note').locator('svg').count(),
          'the info beside the notice',
        ).toBe(1);
      }

      expect(found).toEqual([]);
    });
  });
}
