import { expect, type Page } from '@playwright/test';
import { openWidget, server, strings, test } from './fixtures.js';

/**
 * Mixed-direction text in the Arabic widget (M9-04, WCAG 1.3.2 Meaningful
 * Sequence; `docs/completed/accessibility-audit.md`). A ticket reference or
 * an email address is left-to-right text inside a right-to-left sentence. If
 * it is just part of the sentence, the full stop after it, and any neighbouring
 * digits, are placed by the bidi algorithm's guess; wrapped in `<bdi>` it is
 * an isolate that keeps its own direction and nothing leaks across it. The
 * values are the ones the harness and the mock transport really produce.
 */

const EMAIL = 'omar.k@example.com';
const REFERENCE = /HD-\d+/;

interface Isolation {
  /** Text nodes in the widget that hold the value. */
  readonly found: number;
  /** Of those, the ones whose element is a `<bdi>` (or `dir="ltr"`) holding just the value. */
  readonly isolated: number;
}

/** Where the value is written in the widget, and whether each place sets it apart. */
function isolation(page: Page, pattern: RegExp): Promise<Isolation> {
  return page.evaluate(
    ({ source }) => {
      const root = document.querySelector('helpdock-widget')?.shadowRoot;
      const value = new RegExp(source);
      const whole = new RegExp(`^(?:${source})$`);
      let found = 0;
      let isolated = 0;
      const walker = document.createTreeWalker(root ?? document, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        if (!value.test(text)) {
          continue;
        }
        found += 1;
        const owner = node.parentElement;
        if (owner?.matches('bdi, [dir=ltr]') && whole.test((owner.textContent ?? '').trim())) {
          isolated += 1;
        }
      }
      return { found, isolated };
    },
    { source: pattern.source },
  );
}

test.describe('ar', () => {
  const t = strings('ar');

  test('the reference and the email address in the contact form confirmation are isolated', async ({
    page,
  }) => {
    await openWidget(page, 'ar', 'mode=form&availability=open_offline');
    await page.getByRole('textbox', { name: t('prechat.name') }).fill('Omar Khalil');
    await page.getByRole('textbox', { name: t('prechat.email') }).fill(EMAIL);
    await page.getByRole('textbox', { name: t('form.message') }).fill('Change my address.');
    await page.getByRole('button', { name: t('form.submit') }).click();
    await expect(page.getByRole('button', { name: t('form.another') })).toBeVisible();

    expect(await isolation(page, REFERENCE), 'the reference').toEqual({ found: 1, isolated: 1 });
    expect(await isolation(page, new RegExp(EMAIL)), 'the email address').toEqual({
      found: 1,
      isolated: 1,
    });
  });

  test('the email address in the first-message notice and in the handoff line is isolated', async ({
    page,
  }) => {
    await openWidget(page, 'ar', 'prechat=1');
    await page.getByRole('textbox', { name: t('prechat.name') }).fill('Omar Khalil');
    await page.getByRole('textbox', { name: t('prechat.email') }).fill(EMAIL);
    await page
      .getByRole('textbox', { name: t('prechat.message') })
      .fill('My refund for order 8841 has not arrived.');
    await page.getByRole('button', { name: t('prechat.submit') }).click();
    await expect(page.getByText(t('message.sent'))).toBeVisible();
    expect(await isolation(page, new RegExp(EMAIL)), 'the notice').toEqual({
      found: 1,
      isolated: 1,
    });

    await server(
      page,
      `const { answer } = window.helpdock.ai; mock.aiReply(answer.body, answer.ai);`,
    );
    await page.getByRole('button', { name: t('ai.talkToHuman') }).click();
    await expect(page.getByText(t('ai.connecting'))).toBeVisible();
    expect(await isolation(page, new RegExp(EMAIL)), 'the notice and the handoff line').toEqual({
      found: 2,
      isolated: 2,
    });
  });

  test('the email address in the transcript confirmation is isolated', async ({ page }) => {
    await openWidget(page, 'ar', 'prechat=1');
    await page.getByRole('textbox', { name: t('prechat.name') }).fill('Omar Khalil');
    await page.getByRole('textbox', { name: t('prechat.email') }).fill(EMAIL);
    await page
      .getByRole('textbox', { name: t('prechat.message') })
      .fill('My refund for order 8841 has not arrived.');
    await page.getByRole('button', { name: t('prechat.submit') }).click();
    await expect(page.getByText(t('message.sent'))).toBeVisible();
    await server(page, 'mock.end();');
    await page.getByRole('button', { name: t('ended.send') }).click();
    await expect(page.getByRole('status')).toBeVisible();

    expect(await isolation(page, new RegExp(EMAIL)), 'the notice and the confirmation').toEqual({
      found: 2,
      isolated: 2,
    });
  });
});
