import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import { MOCK_BRANDS, MOCK_USER } from '../src/auth/mock-api.js';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

const [firstBrand, secondBrand] = MOCK_BRANDS;

const accountMenuLabel = (locale: Locale): string =>
  strings(locale)('admin:currentUser.menuLabel', { name: MOCK_USER.name });

const viewportWidth = (page: Page): number => page.viewportSize()?.width ?? 0;

/** Which half of the viewport a measured element sits in. */
function sidebarHalf(box: { x: number; width: number } | null, width: number): 'start' | 'end' {
  if (!box) {
    throw new Error('the sidebar was not rendered');
  }

  return box.x + box.width / 2 < width / 2 ? 'start' : 'end';
}

test.describe('the admin shell', () => {
  test('switches brand from the keyboard alone', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);

    const switcher = page.getByRole('button', { name: t('admin:brandSwitcher.action') });
    await switcher.focus();
    await page.keyboard.press('Enter');

    const menu = page.getByRole('menu', { name: t('admin:brandSwitcher.action') });
    await expect(menu).toBeVisible();
    await expect(
      menu.getByRole('menuitemradio', { name: firstBrand?.name ?? '', exact: true }),
    ).toHaveAttribute('aria-checked', 'true');

    // The menu opens with the current brand focused, so one step down is the next.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    await expect(switcher).toContainText(secondBrand?.name ?? '');
  });

  test('marks the open page and moves the marker when another is opened', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);

    await expect(page.locator('a[aria-current="page"]')).toContainText(t('admin:nav.tickets'));

    await page.getByRole('link', { name: new RegExp(t('admin:nav.staff')) }).click();

    await expect(page.locator('a[aria-current="page"]')).toContainText(t('admin:nav.staff'));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(t('admin:nav.staff'));
    await expect(page.getByText(t('admin:pages.empty.body.staff'))).toBeVisible();
  });

  test('the language toggle flips the document and the sidebar to the other side', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    const other = locale === 'ar' ? 'en' : 'ar';
    const otherT = strings(other);
    await signIn(page, locale);

    const sidebar = page.getByRole('navigation', { name: t('admin:nav.label') });
    const before = await sidebar.boundingBox();

    await page.getByRole('button', { name: accountMenuLabel(locale) }).click();
    await page
      .getByRole('menuitem', {
        name: t('common:language.switchTo', { language: t(`common:language.${other}`) }),
      })
      .click();

    await expect(page.locator('html')).toHaveAttribute('dir', other === 'ar' ? 'rtl' : 'ltr');
    await expect(page.locator('html')).toHaveAttribute('lang', other);

    const after = await page
      .getByRole('navigation', { name: otherT('admin:nav.label') })
      .boundingBox();

    // The sidebar is a `border-inline-start` column, so it sits on the left in
    // LTR and on the right in RTL. Comparing which half of the viewport it
    // occupies says that in a way a pixel delta does not.
    expect(sidebarHalf(before, viewportWidth(page))).toBe(locale === 'ar' ? 'end' : 'start');
    expect(sidebarHalf(after, viewportWidth(page))).toBe(other === 'ar' ? 'end' : 'start');
  });

  test('signs out back to the sign-in screen', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);

    await page.getByRole('button', { name: accountMenuLabel(locale) }).click();
    await page.getByRole('menuitem', { name: t('admin:currentUser.signOut') }).click();

    await expect(
      page.getByRole('heading', { name: t('auth:signIn.title'), level: 1 }),
    ).toBeVisible();
  });

  test('collapses into a drawer on a narrow viewport', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await page.setViewportSize({ width: 900, height: 800 });

    const nav = page.getByRole('navigation', { name: t('admin:nav.label') });
    await expect(nav).toBeHidden();

    await page.getByRole('button', { name: t('admin:nav.open') }).click();
    await expect(nav).toBeVisible();

    await page.getByRole('link', { name: new RegExp(t('admin:nav.contacts')) }).click();

    await expect(nav).toBeHidden();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(t('admin:nav.contacts'));
  });
});
