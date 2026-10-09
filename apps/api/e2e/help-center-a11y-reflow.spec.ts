import { expect, type Page } from '@playwright/test';
import { HELP_CENTER_URL, HELP_CENTER_WALL_URL } from './fixtures.ts';
import { FALLBACK_ARTICLE, PAGES, path, test } from './help-center-pages.ts';

/**
 * Zoom and reflow on the published help center (M9-04; WCAG 1.4.4 Resize
 * Text, 1.4.10 Reflow; `docs/completed/accessibility-audit.md`). Browser zoom
 * shrinks the CSS viewport: on a 1280 × 1024 window 200 % is 640 × 512 CSS px
 * and 400 % is 320 × 256. Each page type, once per language (the `en` and
 * `ar` projects), is opened at both sizes and must not scroll sideways, must
 * keep every link, button and field inside the viewport and under its own
 * centre, and must not cut off the text of a heading, button, link or strip.
 * Reflow does not depend on the colour scheme, so the specs run in light.
 */

test.use({ reducedMotion: 'reduce', baseURL: HELP_CENTER_URL });

const ZOOMS = [
  ['200 % zoom (640 CSS px)', { width: 640, height: 512 }],
  ['400 % zoom (320 CSS px)', { width: 320, height: 256 }],
] as const;

/** Runs in the page: what is wrong with the page at this viewport. */
function reflowProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const scroller = document.scrollingElement ?? document.documentElement;
    if (scroller.scrollWidth > scroller.clientWidth) {
      problems.push(
        `the page scrolls sideways (${scroller.scrollWidth} > ${scroller.clientWidth})`,
      );
    }
    const name = (element: Element): string =>
      `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(' ')[0]}` : ''} "${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 32)}"`;

    const controls = document.querySelectorAll<HTMLElement>(
      'a[href], button, input:not([type=hidden]), textarea, select',
    );
    for (const control of controls) {
      // The skip link is clipped to 1 px until it has focus, by design.
      if (control.matches('.hd-skip') || control.getClientRects().length === 0) {
        continue;
      }
      if (getComputedStyle(control).visibility === 'hidden') {
        continue;
      }
      control.scrollIntoView({ block: 'center', inline: 'nearest' });
      // A link that wraps has one box per line; its first line is the one to reach.
      const boxes = [...control.getClientRects()].filter((box) => box.width > 0 && box.height > 0);
      const first = boxes[0];
      if (first === undefined) {
        continue;
      }
      if (boxes.some((box) => box.left < -0.5 || box.right > scroller.clientWidth + 0.5)) {
        problems.push(`${name(control)} leaves the viewport sideways`);
        continue;
      }
      const hit = document.elementFromPoint(
        first.left + first.width / 2,
        first.top + first.height / 2,
      );
      if (
        !hit ||
        !(control === hit || control.contains(hit) || hit.closest('label')?.contains(control))
      ) {
        problems.push(
          `${name(control)} is clipped or covered (its centre is on ${hit ? name(hit) : 'nothing'})`,
        );
      }
    }

    const texts = document.querySelectorAll<HTMLElement>(
      'h1, h2, h3, button, a, label, legend, [role=status], [role=note], .hd-badge, .hd-chip, .hd-caption, .hd-label-internal',
    );
    for (const element of texts) {
      if (element.matches('.hd-skip') || element.closest('pre, table')) {
        continue;
      }
      if (element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1) {
        problems.push(
          `${name(element)} cuts its text off sideways (${element.scrollWidth} > ${element.clientWidth})`,
        );
      }
      if (
        element.tagName === 'BUTTON' &&
        element.clientHeight > 0 &&
        element.scrollHeight > element.clientHeight + 1
      ) {
        problems.push(`${name(element)} cuts its text off at the bottom`);
      }
    }
    return problems;
  });
}

for (const [zoom, viewport] of ZOOMS) {
  test.describe(zoom, () => {
    test.use({ viewport });

    test('every page type reflows: no sideways scroll, every control reachable, no text cut off', async ({
      page,
      pageLocale,
    }) => {
      const found: string[] = [];
      const check = async (state: string) => {
        await page.evaluate(() => document.fonts.ready);
        for (const line of await reflowProblems(page)) {
          found.push(`${state}: ${line}`);
        }
      };

      for (const [name, rest, status] of PAGES) {
        const response = await page.goto(path(`/${pageLocale}${rest}`));
        expect(response?.status(), name).toBe(status);
        await check(name);
      }
      if (pageLocale === 'ar') {
        await page.goto(path(FALLBACK_ARTICLE));
        await check('article in the default language, with the notice');
      }
      const wall = await page.goto(`${HELP_CENTER_WALL_URL}${path(`/${pageLocale}`)}`);
      expect(wall?.status()).toBe(401);
      await check('internal-only wall');

      expect(found).toEqual([]);
    });
  });
}
