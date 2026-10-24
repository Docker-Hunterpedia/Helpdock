import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { MOCK_BRANDS } from '../src/auth/mock-api.js';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M14-13 in a real browser, in both languages (`Admin/SetupChecklist`): the
 * "Get set up" entry at the foot of the sidebar and the panel it opens. The api
 * is the mock adapter: the first brand is three steps in, the second has done
 * every required step, and the third refuses the checklist. That each step
 * ticks from the brand's own data is the api's integration suite.
 */

test.use({ reducedMotion: 'reduce' });

const [, finishedBrand, refusedBrand] = MOCK_BRANDS;

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

async function switchBrand(page: Page, locale: 'en' | 'ar', name: string): Promise<void> {
  const t = strings(locale);
  await page.getByRole('button', { name: t('admin:brandSwitcher.action') }).click();
  await page
    .getByRole('menu', { name: t('admin:brandSwitcher.action') })
    .getByRole('menuitemradio', { name, exact: true })
    .click();
}

test('shows how far along the brand is, opens the steps and passes axe', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);

  const entry = page.getByRole('button', {
    name: t('admin:setupChecklist.entryLabel', { done: 3, total: 9 }),
  });
  await expect(entry).toBeVisible();
  await expect(entry).toContainText(t('admin:setupChecklist.entry', { done: 3, total: 9 }));

  await entry.click();
  const panel = page.getByRole('dialog', { name: t('admin:setupChecklist.title') });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByText(t('admin:setupChecklist.progress', { done: 3, total: 9 })),
  ).toBeVisible();
  await expect(panel.getByRole('listitem')).toHaveCount(9);
  await expect(panel.getByRole('link')).toHaveCount(6);
  await expect(
    panel.getByRole('link', {
      name: t('admin:setupChecklist.goTo', { step: t('admin:setupChecklist.steps.channel.title') }),
    }),
  ).toHaveCount(0);

  expect(await violations(page)).toEqual([]);
});

test('takes a step’s link to the page where it is done, and the panel closes with Escape', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);

  const entry = page.getByRole('button', {
    name: t('admin:setupChecklist.entryLabel', { done: 3, total: 9 }),
  });
  await entry.click();
  await page
    .getByRole('link', {
      name: t('admin:setupChecklist.goTo', {
        step: t('admin:setupChecklist.steps.slaPolicy.title'),
      }),
    })
    .click();

  await expect(page).toHaveURL(/\/settings\/inbox\/slas$/);

  await entry.click();
  await expect(page.getByRole('dialog', { name: t('admin:setupChecklist.title') })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: t('admin:setupChecklist.title') })).toHaveCount(0);
  await expect(entry).toBeFocused();
});

test('hides the checklist for the person who asks', async ({ page, appLocale: locale }) => {
  const t = strings(locale);
  await signIn(page, locale);

  await page
    .getByRole('button', { name: t('admin:setupChecklist.entryLabel', { done: 3, total: 9 }) })
    .click();
  await page.getByRole('button', { name: t('admin:setupChecklist.hide') }).click();

  await expect(page.getByRole('dialog', { name: t('admin:setupChecklist.title') })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: t('admin:setupChecklist.entryLabel', { done: 3, total: 9 }) }),
  ).toHaveCount(0);
});

test('draws nothing for a brand that has finished setup, or one that refuses the checklist', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  const entry = page.getByRole('button', { name: t('admin:setupChecklist.title'), exact: false });
  const switcher = page.getByRole('button', { name: t('admin:brandSwitcher.action') });
  await expect(entry).toBeVisible();

  await switchBrand(page, locale, finishedBrand?.name ?? '');
  await expect(switcher).toContainText(finishedBrand?.name ?? '');
  await expect(entry).toHaveCount(0);

  await switchBrand(page, locale, refusedBrand?.name ?? '');
  await expect(switcher).toContainText(refusedBrand?.name ?? '');
  await expect(entry).toHaveCount(0);
});
