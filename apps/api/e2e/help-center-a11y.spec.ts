import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { HELP_CENTER_URL, HELP_CENTER_WALL_URL } from './fixtures.ts';
import { FALLBACK_ARTICLE, PAGES, path, strings, tabCycle, test } from './help-center-pages.ts';

/**
 * The accessibility audit of the published help center (M9-04,
 * REQUIREMENTS §5.4, DESIGN §10; results in
 * `docs/completed/accessibility-audit.md`): axe against WCAG 2.1 A and AA on
 * every page type in both schemes, once per language (the `en` and `ar`
 * projects), then keyboard-only passes — the skip link, a ring on every stop,
 * and "Was this helpful?" with its "What was missing?" step
 * (`HelpCenter/Article-AR` panels 2 and 3).
 */

test.use({ reducedMotion: 'reduce', baseURL: HELP_CENTER_URL });

async function violations(page: Page): Promise<string[]> {
  await page.evaluate(() => document.fonts.ready);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    // The article's video is a third-party player; its frame is not ours to audit.
    .exclude('iframe')
    .analyze();
  return result.violations.map(
    (violation) =>
      `${violation.id} (${violation.nodes.length}): ${violation.help} — ${violation.nodes
        .map((node) => node.target.join(' '))
        .join(', ')}`,
  );
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });

    test('every page type passes axe', async ({ page, pageLocale }) => {
      const found: string[] = [];
      for (const [name, rest, status] of PAGES) {
        const response = await page.goto(path(`/${pageLocale}${rest}`));
        expect(response?.status(), name).toBe(status);
        for (const line of await violations(page)) {
          found.push(`${name}: ${line}`);
        }
      }
      if (pageLocale === 'ar') {
        await page.goto(path(FALLBACK_ARTICLE));
        for (const line of await violations(page)) {
          found.push(`article in the default language: ${line}`);
        }
      }
      const wall = await page.goto(`${HELP_CENTER_WALL_URL}${path(`/${pageLocale}`)}`);
      expect(wall?.status()).toBe(401);
      for (const line of await violations(page)) {
        found.push(`internal-only wall: ${line}`);
      }

      expect(found).toEqual([]);
    });
  });
}

test('the skip link is the first stop, shows when focused, and moves focus to the content', async ({
  page,
  pageLocale,
}) => {
  const t = strings(pageLocale);
  await page.goto(path(`/${pageLocale}/articles/refund-timelines`));

  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: t('nav.skip') });
  await expect(skip).toBeFocused();
  const box = await skip.boundingBox();
  expect(box?.width).toBeGreaterThan(40);
  expect(box?.height).toBeGreaterThanOrEqual(44);

  await page.keyboard.press('Enter');
  await expect(page.locator('#hd-main')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('main').getByRole('link').first()).toBeFocused();
});

test('every stop on an article shows a focus ring, none is hidden, and Tab reaches every control', async ({
  page,
  pageLocale,
}) => {
  const t = strings(pageLocale);
  await page.goto(path(`/${pageLocale}/articles/refund-timelines`));

  const { stops, unreached } = await tabCycle(page);

  // The video's player is a third-party frame: once Tab is inside it, the ring is the player's own.
  const ours = stops.filter((stop) => !stop.name.startsWith('iframe'));
  expect(ours.map((stop) => stop.name)).toEqual(
    expect.arrayContaining([
      `a ${t('nav.skip')}`,
      `button ${t('article.feedback.yes')}`,
      `button ${t('article.feedback.no')}`,
    ]),
  );
  expect(ours.filter((stop) => !stop.ring || !stop.visible)).toEqual([]);
  expect(unreached).toEqual([]);
});

test('"No" asks what was missing; Send records the note and thanks the reader', async ({
  page,
  pageLocale,
}) => {
  const t = strings(pageLocale);
  await page.goto(path(`/${pageLocale}/articles/refund-timelines`));

  await page.getByRole('button', { name: t('article.feedback.no') }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/feedback=no#hd-feedback-comment$/);
  const note = page.getByRole('textbox', { name: t('article.feedback.missing') });
  await expect(note).toBeFocused();
  await expect(page.getByRole('button', { name: t('article.feedback.no') })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(note).toHaveAccessibleDescription(t('article.feedback.hint'));
  expect(await violations(page)).toEqual([]);

  await page.keyboard.type(
    pageLocale === 'ar' ? 'لا شيء عن Apple Pay.' : 'Nothing about Apple Pay.',
  );
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('link', { name: t('article.feedback.skip'), exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: t('article.feedback.send') })).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/feedback=1#feedback$/);
  await expect(page.getByRole('status')).toContainText(t('article.feedback.thanks'));
});

test('Skip leaves the "What was missing?" step without sending a note', async ({
  page,
  pageLocale,
}) => {
  const t = strings(pageLocale);
  await page.goto(path(`/${pageLocale}/articles/refund-timelines?feedback=no`));
  // Only the help center's own origin counts: the article embeds a video whose
  // player posts its own telemetry, which says nothing about the feedback form.
  const posts: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.origin === new URL(page.url()).origin) {
      posts.push(url.pathname);
    }
  });

  await page.getByRole('link', { name: t('article.feedback.skip'), exact: true }).focus();
  await page.keyboard.press('Enter');

  await expect(page.getByRole('status')).toContainText(t('article.feedback.thanks'));
  expect(posts).toEqual([]);
});
