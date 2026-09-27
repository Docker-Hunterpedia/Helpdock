import { test as base, expect, type Page } from '@playwright/test';
import { HELP_CENTER_URL } from './fixtures.ts';

/**
 * M5's RTL snapshot: the Arabic article page (artboard `HelpCenter/Article-AR`)
 * against two committed baselines in `e2e/__snapshots__/`.
 *
 * - `article-ar.aria.yml`, the accessibility tree of `<main>`: breadcrumb,
 *   title, body and "Was this helpful?", in Arabic, in reading order.
 * - `article-ar-layout.txt`, where things land on a right-to-left page: which
 *   column each region is in, which side of its box each line of text starts
 *   from, the mirrored chevrons, and the code block that stays left to right.
 *
 * Both are text rather than pixels. The pixel baselines of the admin are Linux
 * renders made in CI (`screenshots.yml`); these two read the same on any
 * machine, so a contributor on macOS can run and update them.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';

const test = base.extend<{ pageLocale: 'en' | 'ar' }>({
  pageLocale: ['en', { option: true }],
});

test.use({ reducedMotion: 'reduce', baseURL: HELP_CENTER_URL });

/**
 * One line per fact. `column` is the third of the viewport an element's centre
 * falls in; `starts` is the side of its own box its first line of text begins
 * on, which is what an RTL layout gets wrong when it forgets `dir`.
 */
const layoutOf = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const column = (element: Element): string => {
      const box = element.getBoundingClientRect();
      const centre = box.left + box.width / 2;
      return centre < width / 3 ? 'left' : centre > (2 * width) / 3 ? 'right' : 'middle';
    };
    const starts = (element: Element): string => {
      const text = [...element.childNodes].find(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
      );
      const range = document.createRange();
      range.selectNodeContents(text ?? element);
      const line = range.getClientRects()[0];
      const box = element.getBoundingClientRect();
      if (line === undefined) {
        return 'empty';
      }
      return Math.abs(line.right - box.right) <= Math.abs(line.left - box.left) ? 'right' : 'left';
    };
    const one = (selector: string): Element => {
      const found = document.querySelector(selector);
      if (found === null) {
        throw new Error(`${selector} is not on the page`);
      }
      return found;
    };
    const facts: [string, string][] = [
      ['html', `lang=${document.documentElement.lang} dir=${document.documentElement.dir}`],
      ['header brand', `column=${column(one('.hd-brand'))}`],
      [
        'header language link',
        `column=${column(one('.hd-lang'))} dir=${one('.hd-lang').getAttribute('dir')}`,
      ],
      ['section nav', `column=${column(one('.hd-page > .hd-side-nav'))}`],
      ['main', `column=${column(one('main'))}`],
      ['aside', `column=${column(one('aside'))}`],
      [
        'title',
        `direction=${getComputedStyle(one('main h1')).direction} starts=${starts(one('main h1'))}`,
      ],
      [
        'body paragraph',
        `direction=${getComputedStyle(one('.hd-body p')).direction} starts=${starts(one('.hd-body p'))}`,
      ],
      ['code block', `direction=${getComputedStyle(one('.hd-body pre')).direction}`],
      [
        'breadcrumb chevrons',
        [...document.querySelectorAll('.hd-breadcrumb .hd-mirror')]
          .map((icon) => (getComputedStyle(icon).transform === 'none' ? 'plain' : 'mirrored'))
          .join(' '),
      ],
      [
        'feedback buttons',
        (() => {
          const [yes, no] = [...document.querySelectorAll('.hd-feedback button')];
          if (yes === undefined || no === undefined) {
            return 'missing';
          }
          return yes.getBoundingClientRect().left > no.getBoundingClientRect().left
            ? 'yes right of no'
            : 'yes left of no';
        })(),
      ],
    ];
    return `${facts.map(([name, value]) => `${name}: ${value}`).join('\n')}\n`;
  });

test('the Arabic article page matches its RTL snapshot', async ({ page, pageLocale }) => {
  test.skip(pageLocale !== 'ar', 'the snapshot is of the Arabic page');
  await page.goto(`/hc/${BRAND}/ar/articles/refund-timelines`);
  await page.evaluate(() => document.fonts.ready);

  await expect(page.locator('main')).toMatchAriaSnapshot({ name: 'article-ar.aria.yml' });
  expect(await layoutOf(page)).toMatchSnapshot('article-ar.layout.txt');
});
