import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * Channels › Widget in a real browser, in both languages (artboard
 * `AdminWidget`; M4-03, M4-06 to M4-08): the preview following the draft,
 * the save, the origin refused and accepted, and the signing secret shown
 * once — each screen checked with axe.
 */

test.use({ reducedMotion: 'reduce' });

async function violations(page: Page): Promise<string[]> {
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

async function openWidget(page: Page, locale: 'en' | 'ar'): Promise<void> {
  const t = strings(locale);
  await page.getByRole('link', { name: new RegExp(t('admin:nav.channels')) }).click();
  await page.getByRole('tab', { name: t('channels:tabs.widget') }).click();
  await page.getByRole('heading', { name: t('channels:widget.appearance.heading') }).waitFor();
}

test.describe('Channels › Widget', () => {
  test('saves the look the preview shows', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openWidget(page, locale);
    const appearance = page.getByRole('region', { name: t('channels:widget.appearance.heading') });
    const preview = page.getByRole('complementary', { name: t('channels:widget.preview.heading') });

    await appearance
      .getByRole('radio', {
        name: new RegExp(`^${t('channels:widget.appearance.modes.helpcenter.label')}`),
      })
      .check();
    await appearance
      .getByRole('button', { name: t('channels:widget.appearance.launchers.icon_text') })
      .click();
    await expect(preview.getByText(t('channels:widget.preview.launcherText'))).toBeVisible();
    await appearance.getByRole('button', { name: t('channels:widget.save') }).click();

    await expect(
      page.getByRole('status').filter({ hasText: t('channels:widget.appearance.saved') }),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('refuses an origin with a path and keeps one without', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openWidget(page, locale);
    const access = page.getByRole('region', { name: t('channels:widget.access.heading') });
    const field = access.getByRole('textbox', { name: t('channels:widget.access.addLabel') });

    await field.fill('https://shop.example.com/checkout');
    await access.getByRole('button', { name: t('channels:widget.access.add') }).click();
    await expect(access.getByText(t('channels:widget.access.badOrigin'))).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await field.fill('https://shop.example.com');
    await access.getByRole('button', { name: t('channels:widget.access.add') }).click();
    await expect(access.getByText('https://shop.example.com', { exact: true })).toBeVisible();
    await access.getByRole('button', { name: t('channels:widget.save') }).click();
    await expect(
      page.getByRole('status').filter({ hasText: t('channels:widget.access.saved') }),
    ).toBeVisible();
  });

  test('shows a new signing secret once', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openWidget(page, locale);
    const signed = page.getByRole('region', { name: t('channels:widget.signed.heading') });

    await signed.getByRole('button', { name: t('channels:widget.signed.replace') }).click();
    await expect(signed.getByLabel(t('channels:widget.signed.newSecret'))).toHaveValue(/^whsec_/);
    expect(await violations(page)).toEqual([]);

    await signed.getByRole('button', { name: t('channels:widget.signed.done') }).click();
    await expect(signed.getByLabel(t('channels:widget.signed.newSecret'))).toHaveCount(0);
  });
});
