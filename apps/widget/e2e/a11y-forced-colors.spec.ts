import { expect, type Page } from '@playwright/test';
import {
  LOCALES,
  type Locale,
  openWidget,
  server,
  startClockBeforeOpening,
  strings,
  tabCycle,
  test,
} from './fixtures.js';

/**
 * The widget in forced colours (Windows High Contrast; M9-04, WCAG 1.4.1 and
 * 2.4.7; `docs/completed/accessibility-audit.md`). The browser throws away
 * every background, shadow and brand colour and draws the page in the
 * system's palette, so what is left must carry the meaning on its own: the
 * focus ring (an outline, which stays), a pressed button (a thicker border,
 * not a tint), and the icons that sit beside a state (SVG drawn in the text
 * colour, which is forced). Run in both schemes because the system palette
 * follows the scheme.
 */

const SCHEMES = ['light', 'dark'] as const;

/** Forced colours on, and the browser confirms it took them. */
async function forceColors(page: Page): Promise<void> {
  await page.emulateMedia({ forcedColors: 'active' });
  await expect
    .poll(() => page.evaluate(() => matchMedia('(forced-colors: active)').matches))
    .toBe(true);
}

/** Every icon under `scope` in the widget, and what stops it from being drawn. */
function iconProblems(page: Page, scope: string): Promise<{ count: number; problems: string[] }> {
  return page.evaluate((selector) => {
    const root = document.querySelector('helpdock-widget')?.shadowRoot;
    const icons = [...(root?.querySelectorAll<SVGElement>(`${selector} svg`) ?? [])];
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
          `icon in ${owner?.className.split(' ')[0] ?? owner?.tagName.toLowerCase()} "${(owner?.textContent ?? '').trim().slice(0, 24)}": ${why.join(', ')}`,
        );
      }
    }
    return { count: icons.length, problems };
  }, scope);
}

/** What a button has besides colour: the width and style of its border and of its outline, and its `aria-pressed`. */
function edges(
  page: Page,
  selector: string,
): Promise<{ pressed: string | null; border: string; outline: string }[]> {
  return page.evaluate((query) => {
    const root = document.querySelector('helpdock-widget')?.shadowRoot;
    return [...(root?.querySelectorAll<HTMLElement>(query) ?? [])].map((element) => {
      const style = getComputedStyle(element);
      return {
        pressed: element.getAttribute('aria-pressed'),
        border: `${style.borderTopWidth} ${style.borderTopStyle}`,
        outline: `${style.outlineWidth} ${style.outlineStyle}`,
      };
    });
  }, selector);
}

for (const locale of LOCALES) {
  const t = strings(locale);

  for (const scheme of SCHEMES) {
    test.describe(`${locale} ${scheme}, forced colours`, () => {
      test.use({ colorScheme: scheme });
      test.beforeEach(async ({ page }) => {
        await forceColors(page);
      });
      const query = (extra = '') => `scheme=${scheme}${extra ? `&${extra}` : ''}`;

      const MODES: readonly {
        readonly name: string;
        readonly extra: string;
        readonly setup?: (page: Page, locale: Locale) => Promise<void>;
      }[] = [
        { name: 'the chat window', extra: '' },
        {
          name: 'the rating card',
          extra: '',
          setup: async (page) => {
            await page.keyboard.type('My refund for order 8841 has not arrived.');
            await page.keyboard.press('Enter');
            await expect(page.getByText(t('message.sent'))).toBeVisible();
            await server(
              page,
              `mock.assign(agent, 'Billing'); mock.agentReply(agent, 'The trace is back.'); mock.end(); mock.offerCsat();`,
            );
            await expect(page.getByRole('form', { name: t('csat.question') })).toBeVisible();
          },
        },
        { name: 'the pre-chat form', extra: 'prechat=1' },
        { name: 'the contact form', extra: 'mode=form&availability=open_offline' },
        {
          name: 'the help center with results',
          extra: 'mode=helpcenter',
          setup: async (page) => {
            await page.keyboard.type(locale === 'ar' ? 'إرجاع' : 'return');
            await expect(
              page.getByRole('list', { name: t('articles.resultsLabel') }).getByRole('link'),
            ).not.toHaveCount(0);
          },
        },
      ];

      for (const mode of MODES) {
        test(`every Tab stop in ${mode.name} still draws a focus ring`, async ({ page }) => {
          await openWidget(page, locale, query(mode.extra));
          await mode.setup?.(page, locale);

          const { stops, tabbable } = await tabCycle(page);

          const inWidget = stops.filter((stop) => stop.name !== '(page)');
          expect(tabbable).toBeGreaterThan(3);
          expect(
            new Set(inWidget.map((stop) => stop.name)).size,
            'every tabbable element had focus',
          ).toBe(tabbable);
          expect(inWidget.filter((stop) => !stop.ring).map((stop) => stop.name)).toEqual([]);
        });
      }

      test('the pressed rating is told from the others by its border, not its colour, and says so', async ({
        page,
      }) => {
        await openWidget(page, locale, query());
        await page.keyboard.type('My refund for order 8841 has not arrived.');
        await page.keyboard.press('Enter');
        await server(
          page,
          `mock.assign(agent, 'Billing'); mock.agentReply(agent, 'The trace is back.'); mock.end(); mock.offerCsat();`,
        );
        const card = page.getByRole('form', { name: t('csat.question') });
        await card
          .getByRole('button', {
            name: t('csat.choice', { rating: 4, label: t('csat.ratings.4') }),
          })
          .click();

        const ratings = await edges(page, '.hd-csat-score');
        expect(ratings.map((rating) => rating.pressed)).toEqual([
          'false',
          'false',
          'false',
          'true',
          'false',
        ]);
        const pressed = ratings[3];
        for (const other of ratings.filter((_, index) => index !== 3)) {
          expect(
            { border: other.border, outline: other.outline },
            'an unpressed rating looks like the pressed one once colour is gone',
          ).not.toEqual({ border: pressed?.border, outline: pressed?.outline });
        }
      });

      test('the "Was this helpful?" buttons keep a drawn edge, so they are found without their tint', async ({
        page,
      }) => {
        await openWidget(page, locale, query());
        await page.keyboard.type('How long does a refund take?');
        await page.keyboard.press('Enter');
        await expect(page.getByText(t('message.sent'))).toBeVisible();
        await server(
          page,
          `const { answer } = window.helpdock.ai; mock.aiReply(answer.body, answer.ai);`,
        );
        await expect(page.getByRole('button', { name: t('ai.yes') })).toBeVisible();

        const buttons = await edges(page, '.hd-ai-feedback button');
        expect(buttons).toHaveLength(2);
        for (const button of buttons) {
          expect(button.pressed).toBe('false');
          expect(button.border).toMatch(/^[1-9]\d*(\.\d+)?px solid$/);
        }
      });

      test('the icons beside Sending, Sent and Seen are drawn in the text colour', async ({
        page,
      }) => {
        const found: string[] = [];
        const read = async (state: string, scope: string) => {
          const { count, problems } = await iconProblems(page, scope);
          if (count === 0) {
            found.push(`${state}: no icon found under ${scope}`);
          }
          found.push(...problems.map((problem) => `${state}: ${problem}`));
        };

        await openWidget(page, locale, query());
        await server(page, 'mock.dropConnection();');
        await page.keyboard.type('Can someone check the bank reference?');
        await page.keyboard.press('Enter');
        await expect(page.getByText(t('message.sending'))).toBeVisible();
        await read('sending', '.hd-meta');

        await server(page, 'mock.restoreConnection();');
        await expect(page.getByText(t('message.sent'))).toBeVisible();
        await read('sent', '.hd-meta');

        await server(page, `mock.emit({ type: 'receipt', kind: 'read', seq: 1 });`);
        await expect(page.getByText(t('message.seen'))).toBeVisible();
        await read('seen', '.hd-meta');

        expect(found).toEqual([]);
      });

      test('the icons beside a message that was not sent, and its Retry, are drawn in the text colour', async ({
        page,
      }) => {
        await openWidget(page, locale, query());
        await server(page, 'mock.failNextSends(1000);');
        await page.keyboard.type('Can someone check the bank reference?');
        await page.keyboard.press('Enter');
        await expect(page.getByRole('button', { name: t('message.retry') })).toBeVisible({
          timeout: 15_000,
        });

        const { count, problems } = await iconProblems(page, '.hd-meta');
        expect(count, 'the alert and the retry icons').toBe(2);
        expect(problems).toEqual([]);
      });

      test('the icon of every strip is drawn in the text colour', async ({ page }) => {
        const found: string[] = [];
        const read = async (state: string) => {
          const { count, problems } = await iconProblems(page, '.hd-banner');
          if (count !== 1) {
            found.push(`${state}: ${count} icons in the strip, expected 1`);
          }
          found.push(...problems.map((problem) => `${state}: ${problem}`));
        };

        await startClockBeforeOpening(page);
        await openWidget(page, locale, query('availability=closed'));
        await expect(page.getByText(t('hours.closedTitle'))).toBeVisible();
        await read('out of hours');

        await page.keyboard.type('Can someone check the bank reference?');
        await page.keyboard.press('Enter');
        await expect(page.getByText(t('message.sent'))).toBeVisible();
        await server(page, 'mock.dropConnection();');
        await expect(page.getByText(t('connection.reconnectingTitle'))).toBeVisible();
        await read('reconnecting');
        await server(page, 'mock.restoreConnection();');
        await expect(page.getByText(t('connection.back'))).toBeVisible();
        await read('back online');

        await openWidget(page, locale, query('prechat=1'));
        await page.getByRole('textbox', { name: t('prechat.name') }).fill('Omar Khalil');
        await page.getByRole('textbox', { name: t('prechat.email') }).fill('omar.k@example.com');
        await page
          .getByRole('textbox', { name: t('prechat.message') })
          .fill('My refund for order 8841 has not arrived.');
        await page.getByRole('button', { name: t('prechat.submit') }).click();
        await server(page, `mock.emit({ type: 'queue', position: 2, eta_seconds: 180 });`);
        await expect(page.getByText(t('header.caption.queued'))).toBeVisible();
        await read('queue position');

        expect(found).toEqual([]);
      });
    });
  }
}
