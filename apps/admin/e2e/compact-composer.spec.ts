import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { DETAILS_INLINE_WIDTH, openTicket, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M14-19 in a real browser, in both languages (`Admin/Ticket-CompactComposer`):
 * the 1280 × 720 workspace with the thread dominant, the composer collapsed and
 * expanded, its growth and its cap, the one-line subject, the 1440 px drawer
 * breakpoint, `[`, the keyboard send, and the one macro entry point.
 */

test.use({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

const open = async (page: Page, locale: 'en' | 'ar') => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicket(page, locale, 'HD-1042', { compact: true });
  const form = page.getByRole('form', { name: t('tickets:composer.label') });
  const summary = form.getByRole('button', { name: /billing@helpdock\.io/ });
  await expect(summary).toBeVisible();

  return {
    t,
    form,
    summary,
    body: form.getByRole('textbox', { name: t('tickets:composer.bodyLabel') }),
  };
};

test.describe('the compact composer at 1280 × 720', () => {
  test('leaves the thread dominant, collapsed and expanded, and passes axe', async ({
    page,
    appLocale: locale,
  }) => {
    const { t, form, summary } = await open(page, locale);
    const thread = page.locator(`div[aria-label="${t('tickets:thread.label')}"]`);
    const height = async (node: typeof form): Promise<number> =>
      (await node.boundingBox())?.height ?? 0;

    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await expect(form.getByRole('combobox', { name: t('tickets:email.from') })).toBeHidden();
    const collapsed = await height(form);
    expect(await height(thread)).toBeGreaterThan(collapsed);
    expect(collapsed).toBeLessThan(260);

    await summary.click();
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    await expect(form.getByRole('combobox', { name: t('tickets:email.from') })).toBeVisible();
    await expect(form.getByText('mona@example.com')).toBeVisible();
    await expect(form.getByText(t('tickets:email.signatureCaption'))).toBeVisible();
    // Opened, the card stops growing at its cap and the thread keeps its room.
    const column = (await page.locator('main').first().boundingBox())?.height ?? 720;
    expect(await height(form.locator('..'))).toBeLessThanOrEqual(column * 0.46);
    expect(await height(thread)).toBeGreaterThan(200);
    expect(await violations(page)).toEqual([]);

    await summary.click();
    await expect(form.getByRole('combobox', { name: t('tickets:email.from') })).toBeHidden();
  });

  test('grows with its text and scrolls inside at 45 % of the column', async ({
    page,
    appLocale: locale,
  }) => {
    const { body } = await open(page, locale);
    const scroller = page.locator('form[data-shortcut-scope="composer"]').locator('..');
    const heightOf = async (): Promise<number> => (await body.boundingBox())?.height ?? 0;

    const start = await heightOf();
    await body.fill('one\ntwo\nthree\nfour');
    expect(await heightOf()).toBeGreaterThan(start);

    await body.fill(Array.from({ length: 60 }, (_, line) => `line ${String(line)}`).join('\n'));
    const capped = await scroller.evaluate((node) => ({
      box: node.getBoundingClientRect().height,
      column: (node.parentElement?.parentElement?.getBoundingClientRect().height ?? 0) as number,
      scrolls: node.scrollHeight > node.clientHeight,
    }));
    expect(capped.scrolls).toBe(true);
    expect(capped.box).toBeLessThanOrEqual(capped.column * 0.46);
  });

  test('keeps the subject on one line, with the whole subject as its name', async ({
    page,
    appLocale: locale,
  }) => {
    const { t } = await open(page, locale);
    const subject = 'Refund for order 42 has not arrived';
    const heading = page
      .getByRole('region', { name: t('tickets:header.label') })
      .getByRole('heading', { level: 2, name: subject });

    await expect(heading).toHaveCSS('white-space', 'nowrap');
    await expect(heading).toHaveCSS('text-overflow', 'ellipsis');
    await heading.hover();
    await expect(page.getByRole('tooltip')).toHaveText(subject);
  });

  test('puts the details in a drawer below 1440 px and beside the thread from it', async ({
    page,
    appLocale: locale,
  }) => {
    const { t } = await open(page, locale);
    const details = page.getByRole('complementary', { name: t('tickets:details.label') });

    await expect(details).toBeHidden();
    await page.getByRole('button', { name: t('tickets:header.details') }).click();
    await expect(details).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(details).toBeHidden();

    await page.setViewportSize({ width: DETAILS_INLINE_WIDTH - 1, height: 720 });
    await expect(details).toBeHidden();
    await page.setViewportSize({ width: DETAILS_INLINE_WIDTH, height: 720 });
    await expect(details).toBeVisible();
  });

  test('hides the list column with [ and brings it back', async ({ page, appLocale: locale }) => {
    const { t } = await open(page, locale);
    const list = page.getByRole('region', { name: t('tickets:list.label') });

    await expect(list).toBeVisible();
    await page.keyboard.press('[');
    await expect(list).toBeHidden();
    await page.keyboard.press('[');
    await expect(list).toBeVisible();

    await page.keyboard.press('[');
    await page.getByRole('button', { name: t('tickets:list.open') }).click();
    await expect(list).toBeVisible();
  });

  test('sends from the keyboard and keeps the composer as it was when the text goes', async ({
    page,
    appLocale: locale,
  }) => {
    const { t, summary, body } = await open(page, locale);

    await summary.click();
    await body.fill('Your refund is on its way.');
    await page.keyboard.press('ControlOrMeta+Enter');

    await expect(page.getByText(t('tickets:toast.replied'))).toBeVisible();
    await expect(body).toHaveValue('');
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
  });

  test('has one macro entry: no header button, the composer’s button, and the palette', async ({
    page,
    appLocale: locale,
  }) => {
    const { t, form } = await open(page, locale);
    const picker = page.getByRole('dialog', { name: t('macros:picker.label') });

    await expect(
      page
        .getByRole('region', { name: t('tickets:header.label') })
        .getByRole('button', { name: /^(Macro|ماكرو)$/ }),
    ).toHaveCount(0);

    await form.getByRole('button', { name: t('tickets:composer.canned') }).click();
    await expect(picker).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();

    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: t('admin:palette.label') });
    await palette.getByRole('combobox').fill('macro');
    await palette.getByRole('option', { name: t('admin:palette.actions.ticket.macros') }).click();
    await expect(picker).toBeVisible();
  });
});
