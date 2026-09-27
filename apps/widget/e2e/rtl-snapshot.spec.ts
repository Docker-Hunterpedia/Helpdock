import type { Locator } from '@playwright/test';
import { expect, openWidget, strings, test } from './fixtures.js';

/**
 * The widget's RTL snapshot (artboard `Widget/States-AR`): the open chat window
 * in Arabic against two committed text baselines in `e2e/__snapshots__/`, the
 * window's accessibility tree and where its parts land on a right-to-left
 * page. Text rather than pixels, as `apps/api/e2e/help-center-rtl.spec.ts`
 * explains, so it reads the same on every machine.
 */

const t = strings('ar');

const side = async (element: Locator, of: Locator): Promise<string> => {
  const [box, container] = await Promise.all([element.boundingBox(), of.boundingBox()]);
  if (box === null || container === null) {
    return 'hidden';
  }
  const centre = box.x + box.width / 2;
  return centre < container.x + container.width / 2 ? 'left' : 'right';
};

const direction = (element: Locator): Promise<string> =>
  element.evaluate((node) => getComputedStyle(node).direction);

test('the Arabic chat window matches its RTL snapshot', async ({ page }) => {
  await openWidget(page, 'ar');
  const body = page.locator('body');
  const window = page.getByRole('region', { name: t('window.label') });
  const composer = window.getByRole('textbox', { name: t('composer.label') });
  const send = window.getByRole('button', { name: t('composer.send') });
  const minimise = window.getByRole('button', { name: t('window.minimise') });

  await expect(window).toMatchAriaSnapshot({ name: 'chat-ar.aria.yml' });

  const facts = [
    `host dir: ${await page.locator('helpdock-widget').getAttribute('dir')}`,
    `window on the page: ${await side(window, body)}`,
    `window direction: ${await direction(window)}`,
    `composer direction: ${await direction(composer)}`,
    `send button in the window: ${await side(send, window)}`,
    `minimise button in the window: ${await side(minimise, window)}`,
  ];
  expect(`${facts.join('\n')}\n`).toMatchSnapshot('chat-ar-layout.txt');
});
