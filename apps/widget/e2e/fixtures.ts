import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page } from '@playwright/test';
import { type Catalog, createTranslator, type Translate } from '../src/i18n/translator.js';

export type Locale = 'en' | 'ar';
export const LOCALES: readonly Locale[] = ['en', 'ar'];

const require = createRequire(import.meta.url);

/** The same catalogs the widget ships, so a test asserts the visitor's words, not ids. */
export function strings(locale: Locale): Translate {
  const file = require.resolve(`@helpdock/i18n/locales/${locale}/widget.json`);
  return createTranslator(JSON.parse(readFileSync(file, 'utf8')) as Catalog, locale);
}

/** DESIGN §10 against WCAG 2.1 A and AA, one line per violation. Axe walks open shadow roots. */
export async function violations(page: Page): Promise<string[]> {
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

/** Opens the harness with the given settings and the window, using the keyboard only. */
export async function openWidget(page: Page, locale: Locale, query = ''): Promise<void> {
  const t = strings(locale);
  await page.goto(`/?locale=${locale}${query ? `&${query}` : ''}`);
  const launcher = page.getByRole('button', { name: t('launcher.open') });
  await expect(launcher).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(launcher).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: t('window.label') })).toBeVisible();
  // Opening moves focus into the window; typing before that would go nowhere.
  await expect(page.locator('helpdock-widget .hd-content :focus')).toHaveCount(1);
}

/** Runs a script against the mock transport the harness exposes as `window.helpdock`. */
export async function server(page: Page, script: string): Promise<void> {
  await page.evaluate(`(() => { const { mock, agent } = window.helpdock; ${script} })()`);
}

/** Transitions off: a panel caught mid-fade reads as low contrast to axe (as in the admin suite). */
export const test = base.extend({});
test.use({ reducedMotion: 'reduce' });

export { expect };
