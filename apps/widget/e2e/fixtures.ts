import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { type Catalog, createTranslator, type Translate } from '../src/i18n/translator.js';

export type Locale = 'en' | 'ar';
export const LOCALES: readonly Locale[] = ['en', 'ar'];

const require = createRequire(import.meta.url);

/** The same catalogs the widget ships, so a test asserts the visitor's words, not ids. */
export function strings(locale: Locale): Translate {
  const file = require.resolve(`@helpdock/i18n/locales/${locale}/widget.json`);
  return createTranslator(JSON.parse(readFileSync(file, 'utf8')) as Catalog, locale);
}

const QUIET_MS = 150;

/**
 * Resolves once the widget has stopped changing: its fonts are in, no finite
 * animation or transition is running in its shadow root, and nothing in it has
 * changed for {@link QUIET_MS}. Axe reads colours one element at a time, so a
 * run that starts while the window is still updating can measure a state that
 * never settles on screen (the header contrast flake recorded in M4, M9-04).
 */
export async function settled(page: Page): Promise<void> {
  await page.evaluate(
    async ({ quietMs, capMs }) => {
      await document.fonts.ready;
      const root = document.querySelector('helpdock-widget')?.shadowRoot ?? document;
      const finite = root
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity);
      await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
      await new Promise<void>((resolve) => {
        const cap = setTimeout(done, capMs);
        let quiet = setTimeout(done, quietMs);
        const observer = new MutationObserver(() => {
          clearTimeout(quiet);
          quiet = setTimeout(done, quietMs);
        });
        function done() {
          clearTimeout(cap);
          clearTimeout(quiet);
          observer.disconnect();
          resolve();
        }
        observer.observe(root, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      });
    },
    { quietMs: QUIET_MS, capMs: 2_000 },
  );
}

/** DESIGN §10 against WCAG 2.1 A and AA, one line per violation. Axe walks open shadow roots. */
export async function violations(page: Page): Promise<string[]> {
  await settled(page);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map(
    (violation) =>
      `${violation.id} (${violation.nodes.length}): ${violation.help} — ${violation.nodes
        .map((node) => node.target.join(' '))
        .join(', ')}`,
  );
}

/** The window: a region beside the page, or a modal dialog where it fills a phone's screen. */
export function widgetWindow(page: Page, locale: Locale): Locator {
  const name = strings(locale)('window.label');
  return page.getByRole('region', { name }).or(page.getByRole('dialog', { name }));
}

/** Opens the harness with the given settings and the window, using the keyboard only. */
export async function openWidget(page: Page, locale: Locale, query = ''): Promise<void> {
  const t = strings(locale);
  await page.goto(`/?locale=${locale}${query ? `&${query}` : ''}`);
  const launcher = page.getByRole('button', { name: t('launcher.open') });
  await expect(launcher).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(launcher).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(widgetWindow(page, locale)).toBeVisible();
  // Opening moves focus into the window; typing before that would go nowhere.
  await expect(page.locator('helpdock-widget .hd-content :focus')).toHaveCount(1);
}

/**
 * Starts the page's clock on the Friday evening before the opening of the
 * mock's `availability=closed`, which is 27 September 2026 (M7-06): an opening
 * already past counts as open, so on any later day the strip, the header
 * caption and the handoff line would all say the team is back. Call it before
 * {@link openWidget}.
 *
 * The clock keeps running from there rather than standing still
 * (`setFixedTime`): a send is retried for ten seconds by `Date.now()`, so
 * under a frozen clock a send that keeps failing is retried for ever and
 * never shows "not sent, Retry".
 */
export async function startClockBeforeOpening(page: Page): Promise<void> {
  await page.clock.install({ time: new Date('2026-09-25T17:40:00Z') });
}

/** Runs a script against the mock transport the harness exposes as `window.helpdock`. */
export async function server(page: Page, script: string): Promise<void> {
  await page.evaluate(`(() => { const { mock, agent } = window.helpdock; ${script} })()`);
}

export interface Stop {
  readonly name: string;
  readonly ring: boolean;
}

/**
 * Presses Tab `count` times and reads, after each press, the accessible name
 * of what has focus inside the widget (or "(page)" when focus left it) and
 * whether a focus indicator is drawn: its own outline, or the outline of the
 * field around it (`.hd-search-field:focus-within`).
 */
export async function tabStops(page: Page, count: number, shift = false): Promise<Stop[]> {
  const stops: Stop[] = [];
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
    stops.push(
      await page.evaluate(() => {
        const active = document.querySelector('helpdock-widget')?.shadowRoot?.activeElement;
        if (!(active instanceof HTMLElement)) {
          return { name: '(page)', ring: false };
        }
        const drawn = (element: Element | null) => {
          if (element === null) {
            return false;
          }
          const style = getComputedStyle(element);
          return style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2;
        };
        const labelled = active.getAttribute('aria-labelledby');
        const name =
          active.getAttribute('aria-label') ??
          (labelled
            ? (active.getRootNode() as ShadowRoot).getElementById(labelled)?.textContent
            : null) ??
          (active.id
            ? (active.getRootNode() as ShadowRoot).querySelector(`label[for="${active.id}"]`)
                ?.textContent
            : null) ??
          active.textContent ??
          '';
        return { name: name.trim(), ring: drawn(active) || drawn(active.parentElement) };
      }),
    );
  }
  return stops;
}

/**
 * Tabs once all the way round what is tabbable in the widget, launcher
 * included: one press more than there are tabbable elements, plus one for the
 * page the focus passes through. `stops` lists what had focus after each press.
 */
export async function tabCycle(page: Page): Promise<{ stops: Stop[]; tabbable: number }> {
  const tabbable = await page.evaluate(() => {
    const root = document.querySelector('helpdock-widget')?.shadowRoot;
    return [
      ...(root?.querySelectorAll<HTMLElement>(
        'button, a[href], input, textarea, select, [tabindex]',
      ) ?? []),
    ].filter(
      (element) =>
        element.tabIndex >= 0 &&
        !element.matches(':disabled') &&
        element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility !== 'hidden',
    ).length;
  });
  return { stops: await tabStops(page, tabbable + 2), tabbable };
}

/** Transitions off: a panel caught mid-fade reads as low contrast to axe (as in the admin suite). */
export const test = base.extend({});
test.use({ reducedMotion: 'reduce' });

export { expect };
