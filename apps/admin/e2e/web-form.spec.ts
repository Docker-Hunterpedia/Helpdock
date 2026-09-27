import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M4-09's admin half in a real browser, in both languages: Channels › Web form
 * (`AdminWebForm`). The public page the form serves is the api's, and has its
 * own Playwright project in `apps/api/e2e/`.
 *
 * Every step navigates by clicking, never by `page.goto`: the fixture keeps
 * its session and its data in memory, and a reload would lose both.
 */

test.use({ reducedMotion: 'reduce' });

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

const openWebForm = async (page: Page, locale: 'en' | 'ar'): Promise<void> => {
  const t = strings(locale);
  await page.getByRole('link', { name: new RegExp(t('admin:nav.channels')) }).click();
  await page.getByRole('tab', { name: t('channels:tabs.webForm') }).click();
  await page.getByRole('heading', { name: t('channels:webForm.hosted.heading') }).waitFor();
};

test.describe('Channels › Web form', () => {
  test('shows the form’s address, fields and what the customer reads', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openWebForm(page, locale);

    const hosted = page.getByRole('region', { name: t('channels:webForm.hosted.heading') });
    await expect(hosted.getByLabel(t('channels:webForm.address.label'))).toHaveValue(
      'https://help.helpdock.io/contact',
    );
    await expect(
      hosted.getByRole('checkbox', {
        name: t('channels:webForm.fields.show', { name: t('channels:webForm.fields.names.email') }),
      }),
    ).toBeDisabled();
    await expect(
      page.getByRole('region', { name: t('channels:webForm.preview.heading') }),
    ).toContainText(t('channels:webForm.preview.title'));
    expect(await violations(page)).toEqual([]);
  });

  test('hides a field and saves the form', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openWebForm(page, locale);

    const hosted = page.getByRole('region', { name: t('channels:webForm.hosted.heading') });
    const name = t('channels:webForm.fields.names.subject');
    await hosted
      .getByRole('checkbox', { name: t('channels:webForm.fields.show', { name }) })
      .click();
    await expect(
      hosted.getByRole('checkbox', { name: t('channels:webForm.fields.require', { name }) }),
    ).toBeDisabled();
    await hosted.getByRole('button', { name: t('channels:webForm.save') }).click();

    await expect(page.getByText(t('channels:webForm.saved'))).toBeVisible();
  });

  test('refuses an empty thank-you message', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openWebForm(page, locale);

    const after = page.getByRole('region', { name: t('channels:webForm.after.heading') });
    await after.getByLabel(t('channels:webForm.thankYou.en')).fill('');
    await after.getByRole('button', { name: t('channels:webForm.save') }).click();

    await expect(after.getByText(t('channels:webForm.thankYou.empty'))).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
});
