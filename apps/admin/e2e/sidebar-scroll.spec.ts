import sharp from 'sharp';
import { MOCK_USER } from '../src/auth/mock-api.js';
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
    if (collapsed && browserName === 'chromium') {
      await expect
        .poll(() => nav.evaluate((el: HTMLElement) => el.offsetWidth - el.clientWidth))
        .toBeLessThanOrEqual(4);
    }
    const userMenu = page.getByRole('button', {
      name: t('admin:currentUser.menuLabel', { name: MOCK_USER.name }),
    });
    if (!collapsed) {
      for (const height of [1000, 560]) {
        await page.setViewportSize({ width: 1280, height });
        const menuBounds = await userMenu.boundingBox();
        if (menuBounds === null) throw new Error('missing user menu');
        for (const row of await nav.locator(':scope > div > ul > li > a').all()) {
          const rowBounds = await row.boundingBox();
          if (rowBounds === null) throw new Error('missing nav row');
          expect(appLocale === 'ar' ? rowBounds.x : rowBounds.x + rowBounds.width).toBeCloseTo(
            appLocale === 'ar' ? menuBounds.x : menuBounds.x + menuBounds.width,
            0,
          );
        }
      }
    } else {
      const menuBounds = await userMenu.boundingBox();
      const iconBounds = await nav.locator('a[href] svg').first().boundingBox();
      if (menuBounds === null || iconBounds === null) throw new Error('missing rail controls');
      expect(iconBounds.x + iconBounds.width / 2).toBeCloseTo(
        menuBounds.x + menuBounds.width / 2,
        1,
      );
    }
    await expect(nav).toHaveAttribute('data-scroll-bottom', 'true');
    await expect(nav).toHaveAttribute('data-scroll-top', 'false');
    const row = nav.locator('a[href]').first();
    const rowBounds = await row.boundingBox();
    if (rowBounds === null) throw new Error('missing first nav row');
    for (const pseudo of ['::before', '::after']) {
      const cue = await nav.evaluate((el, pseudo) => {
        const parent = el.parentElement;
        if (parent === null) throw new Error('missing sidebar scroll frame');
        const style = getComputedStyle(parent, pseudo);
        return {
          x: parent.getBoundingClientRect().x + parseFloat(style.left),
          width: parseFloat(style.width),
        };
      }, pseudo);
      expect(cue.x).toBeCloseTo(rowBounds.x, 1);
      expect(cue.width).toBeCloseTo(rowBounds.width, 1);
    }
    await expect.poll(() => nav.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

    await expect
      .poll(() =>
        nav.evaluate((el) => getComputedStyle(el.parentElement as HTMLElement, '::after').opacity),
      )
      .toBe('1');
    const stops = nav.locator('a[href], button:not([disabled])');
    await page.keyboard.press('Tab');
    await stops.first().focus();
    if (collapsed) {
      await expect(stops.first()).toHaveCSS('outline-width', '2px');
      await expect(stops.first()).toHaveCSS('outline-style', 'solid');
      await expect(stops.first()).toHaveCSS('outline-offset', '-2px');
    }
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
            const style = getComputedStyle(el);
            const ring = Math.max(
              0,
              parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset),
            );
            return {
              label: el.getAttribute('aria-label') ?? el.textContent,
              top: bounds.top - ring >= viewport.top,
              bottom: bounds.bottom + ring <= viewport.top + nav.clientHeight,
              start: bounds.left - ring >= contentStart,
              end: bounds.right + ring <= contentStart + nav.clientWidth,
            };
          }),
        )
        .toMatchObject({
          top: true,
          bottom: true,
          start: true,
          end: true,
        });
    }
    await expect(nav).toHaveAttribute('data-scroll-top', 'true');
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

test('focus in the portalled Views dialog does not request sidebar scrolling', async ({
  page,
  appLocale,
}) => {
  await signIn(page, appLocale);
  const t = strings(appLocale);
  await page.getByRole('button', { name: t('admin:nav.collapse') }).click();
  await page.getByRole('button', { name: t('tickets:views.label') }).click();
  const dialog = page.getByRole('dialog', { name: t('tickets:views.label') });
  // Observe the browser scrolling boundary: React focus bubbles through the portal.
  const scrollRequests = await dialog
    .getByRole('link')
    .first()
    .evaluate((el: HTMLElement) => {
      let requests = 0;
      el.scrollIntoView = () => {
        requests++;
      };
      el.focus();
      return requests;
    });
  expect(scrollRequests).toBe(0);
  await expect(dialog.getByRole('link').first()).toBeFocused();
});

// #340: computed hover styles alone do not prove native scrollbar thumbs repaint.
test('overflowing rail paints its thumb without hover or focus', async ({
  page,
  appLocale,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Native gutter pixels are asserted in Chromium.');
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.addInitScript((key) => localStorage.setItem(key, 'collapsed'), SIDEBAR_STORAGE_KEY);
  await signIn(page, appLocale);
  const nav = page.getByRole('navigation', { name: strings(appLocale)('admin:nav.label') });
  await expect(nav).toHaveCSS('overflow-y', 'auto');
  await expect(nav).toHaveAttribute('data-scroll-bottom', 'true');
  await page.mouse.move(640, 400);
  const gutter = await nav.evaluate((el: HTMLElement) => {
    const bounds = el.getBoundingClientRect();
    return {
      x: getComputedStyle(el).direction === 'rtl' ? bounds.x : bounds.x + el.clientWidth,
      y: bounds.y,
      width: el.offsetWidth - el.clientWidth,
      height: el.clientHeight,
    };
  });
  expect(gutter.width).toBe(4);
  const color = await nav.evaluate(
    (el) => getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor,
  );
  expect(color).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  const rgb = color.match(/\d+/g)?.map(Number);
  if (rgb === undefined) throw new Error('missing opaque thumb color');
  const screenshot = await page.screenshot({ clip: gutter, scale: 'css' });
  await testInfo.attach('rail-gutter', { body: screenshot, contentType: 'image/png' });
  const { data, info } = await sharp(screenshot)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let painted = 0;
  for (let pixel = 0; pixel < data.length; pixel += info.channels) {
    if (rgb.every((channel, index) => data[pixel + index] === channel)) painted++;
  }
  expect(painted, 'the gutter must contain painted border.strong thumb pixels').toBeGreaterThan(20);
});
