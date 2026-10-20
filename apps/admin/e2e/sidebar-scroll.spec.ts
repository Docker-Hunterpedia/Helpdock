import { SIDEBAR_STORAGE_KEY } from '../src/shell/sidebar-collapse.js';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

test.use({
  launchOptions: {
    ignoreDefaultArgs: ['--hide-scrollbars'],
  },
});

// #340: short windows must keep the last admin destination reachable in both layouts.
for (const collapsed of [false, true]) {
  test(`short sidebar scrolls without horizontal overflow (${collapsed ? 'rail' : 'column'})`, async ({
    page,
    appLocale,
    browserName,
  }) => {
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.addInitScript(({ key, choice }) => localStorage.setItem(key, choice), {
      key: SIDEBAR_STORAGE_KEY,
      choice: collapsed ? 'collapsed' : 'expanded',
    });
    await signIn(page, appLocale);
    const t = strings(appLocale);
    const nav = page.getByRole('navigation', { name: t('admin:nav.label') });
    await expect(nav).toHaveAttribute('data-scroll-bottom', 'true');
    await expect(nav).toHaveAttribute('data-scroll-top', 'false');
    await expect.poll(() => nav.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

    await expect
      .poll(() =>
        nav.evaluate((el) => getComputedStyle(el.parentElement as HTMLElement, '::after').opacity),
      )
      .toBe('1');
    const stops = nav.locator('a[href], button:not([disabled])');
    await stops.first().focus();
    // Every control must fit beside the gutter and scroll fully into view using Tab alone.
    for (let index = 0; index < (await stops.count()); index++) {
      const stop = stops.nth(index);
      // WebKit on macOS uses Option+Tab to include links when full keyboard access is off.
      if (index > 0)
        await page.keyboard.press(
          browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab',
        );
      await expect(stop).toBeFocused();
      await expect
        .poll(() =>
          stop.evaluate((el) => {
            const bounds = el.getBoundingClientRect();
            const nav = el.closest('nav');
            if (nav === null) throw new Error('missing sidebar nav');
            const viewport = nav.getBoundingClientRect();
            const contentStart = viewport.left + nav.clientLeft;
            return (
              bounds.top >= viewport.top &&
              bounds.bottom <= viewport.bottom &&
              bounds.left >= contentStart &&
              bounds.right <= contentStart + nav.clientWidth
            );
          }),
        )
        .toBe(true);
    }
    await expect(nav).toHaveAttribute('data-scroll-top', 'true');
    // Nearest-focus scrolling may leave the content's final 4 px padding below the last item.
    await nav.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(nav).toHaveAttribute('data-scroll-bottom', 'false');
    await expect
      .poll(() =>
        nav.evaluate((el) => getComputedStyle(el.parentElement as HTMLElement, '::before').opacity),
      )
      .toBe('1');
    await expect
      .poll(() =>
        nav.evaluate((el) => getComputedStyle(el.parentElement as HTMLElement, '::after').opacity),
      )
      .toBe('0');
  });
}

test('width transitions suppress scrolling and reduced motion skips the animation', async ({
  page,
  appLocale,
}) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await signIn(page, appLocale);
  const t = strings(appLocale);
  const nav = page.getByRole('navigation', { name: t('admin:nav.label') });
  for (const action of ['collapse', 'expand'] as const) {
    await page
      .getByRole('button', { name: t(`admin:nav.${action}`) })
      .evaluate((el) => (el as HTMLButtonElement).click());
    await expect(nav).toHaveCSS('overflow-y', 'hidden');
    await expect(nav).toHaveCSS('overflow-y', 'auto');
    await expect.poll(() => nav.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: t('admin:nav.collapse') }).click();
  await expect(nav).toHaveCSS('animation-name', 'none');
  await expect(nav).toHaveCSS('overflow-y', 'auto');
});
