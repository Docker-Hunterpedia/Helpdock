import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { fillSignIn, signIn, submitTotp } from './flows.js';
import { strings } from './strings.js';

/**
 * Help center › Settings's M5-06 cards (`Admin/HelpCenter-Settings`) in a real
 * browser, in both languages: the theme's contrast line, the featured list
 * reordered by keyboard, a link added and saved, custom CSS sanitised with
 * its removals listed; and M5-03's "View help center" leaving for the help
 * center through the staff pass. Each through axe.
 */

test.use({ reducedMotion: 'reduce' });

const violations = async (page: Page): Promise<string[]> => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map(
    (violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`,
  );
};

const openSettings = async (page: Page, locale: 'en' | 'ar'): Promise<void> => {
  const t = strings(locale);
  await signIn(page, locale);
  await page.getByRole('link', { name: new RegExp(t('admin:nav.helpCenter')) }).click();
  await page.getByRole('tab', { name: t('helpCenter:tabs.settings') }).click();
  await page.getByRole('region', { name: t('helpCenter:site.theme.heading') }).waitFor();
};

test('draws the four cards and passes axe', async ({ page, appLocale: locale }) => {
  const t = strings(locale);
  await openSettings(page, locale);

  for (const heading of [
    'helpCenter:settings.heading',
    'helpCenter:site.theme.heading',
    'helpCenter:site.home.heading',
    'helpCenter:site.links.heading',
    'helpCenter:site.css.heading',
  ] as const) {
    await expect(page.getByRole('heading', { name: t(heading), exact: true })).toBeVisible();
  }
  await expect(
    page.getByText(t('helpCenter:site.theme.contrastPass', { ratio: '5.5' })),
  ).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('refuses an accent that is too light, then saves the theme', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await openSettings(page, locale);
  const theme = page.getByRole('region', { name: t('helpCenter:site.theme.heading') });
  const accent = theme.getByRole('textbox', {
    name: t('helpCenter:site.theme.accent'),
    exact: true,
  });

  await accent.fill('#FFFF00');
  await expect(accent).toHaveAttribute('aria-invalid', 'true');
  await accent.fill('#2B5FB3');
  await theme.getByRole('button', { name: t('helpCenter:settings.save') }).click();
  await expect(page.getByText(t('helpCenter:site.saved'))).toBeVisible();
});

test('reorders the featured list by keyboard and adds a footer link', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await openSettings(page, locale);

  const home = page.getByRole('region', { name: t('helpCenter:site.home.heading') });
  const list = home.getByRole('list', { name: t('helpCenter:site.home.featuredList') });
  const first = await list.getByRole('listitem').first().textContent();
  await list.getByRole('button').first().press('ArrowDown');
  await expect(list.getByRole('listitem').nth(1)).toHaveText(first ?? '');
  await home.getByRole('button', { name: t('helpCenter:settings.save') }).click();
  await expect(page.getByText(t('helpCenter:site.saved'))).toBeVisible();

  const links = page.getByRole('region', { name: t('helpCenter:site.links.heading') });
  await links
    .getByRole('button', { name: t('helpCenter:site.links.add') })
    .last()
    .click();
  const untitled = t('helpCenter:site.links.untitled');
  await links
    .getByRole('textbox', { name: t('helpCenter:site.links.englishLabel', { name: untitled }) })
    .fill('Status');
  // The row is named by its label now, in either language: it has only the English one.
  await links
    .getByRole('textbox', {
      name: t('helpCenter:site.links.addressLabel', { name: 'Status' }),
      exact: true,
    })
    .fill('https://status.acme.test');
  await links.getByRole('button', { name: t('helpCenter:settings.save') }).click();
  await expect(page.getByText(t('helpCenter:site.saved'))).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('lists what saving the custom CSS removed', async ({ page, appLocale: locale }) => {
  const t = strings(locale);
  await openSettings(page, locale);
  const css = page.getByRole('region', { name: t('helpCenter:site.css.heading') });

  await css
    .getByRole('textbox', { name: t('helpCenter:site.css.label') })
    .fill('@import url("https://x.test/a.css");\n.bar { position: fixed; }');
  await css.getByRole('button', { name: t('helpCenter:settings.save') }).click();

  const status = css.getByRole('status');
  await expect(status).toContainText(t('helpCenter:site.css.removedTitle'));
  await expect(status).toContainText(t('helpCenter:site.css.reasons.fixed'));
  expect(await violations(page)).toEqual([]);
});

test('"View help center" leaves for the help center through a staff pass', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await openSettings(page, locale);
  const link = page.getByRole('link', { name: t('helpCenter:viewHelpCenter') });
  await expect(link).toHaveAttribute('target', '_blank');
  const href = (await link.getAttribute('href')) ?? '';
  await page.route('https://help.helpdock.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>help center</title>' }),
  );

  // A new tab starts without the fixture's in-memory session, as a real one
  // may after its access token lapsed: it signs in and comes back to the step.
  await page.goto(href);
  await fillSignIn(page, locale);
  await submitTotp(page, locale);
  await page.waitForURL(/help\.helpdock\.test\/_hd\/staff\?pass=/);
});
