import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { openTicket, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M7-05, M7-08 and M7-09 in a real browser, in both languages, against the
 * assist fixture: the Assist menu and a suggested reply (`Admin/Ticket-AI`
 * panels 1 and 2), "Show redacted" (panel 4), a voice note's transcript, and
 * "Draft article" through to Help center › Proposals, where a Team Leader
 * rejects one and approves another (`Admin/HelpCenter-ArticleApproval`).
 *
 * Every step navigates by clicking: the fixture keeps its session and data
 * in memory, and a reload would lose both.
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

test.describe('agent assist on a ticket', () => {
  test('suggests a reply, marks the internal source and leaves it out on Insert', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale, 'HD-1041');

    await page.getByRole('button', { name: t('tickets:assist.button') }).click();
    const menu = page.getByRole('menu');
    await expect(
      menu.getByRole('menuitem', { name: new RegExp(t('tickets:assist.menu.draftArticle')) }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(await violations(page)).toEqual([]);
    await menu.getByRole('menuitem', { name: t('tickets:assist.menu.suggestReply') }).click();

    const card = page.getByRole('region', { name: t('tickets:assist.reply.title') });
    await expect(card.getByText(t('tickets:assist.removedOnInsert'))).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await card.getByRole('button', { name: t('tickets:assist.reply.insert') }).click();

    const body = page.getByRole('textbox', { name: t('tickets:composer.bodyLabel') });
    await expect(body).toHaveValue(/\[1\] Refund timelines/);
    await expect(body).not.toHaveValue(/\[2\]/);
  });

  test('shows what the model received, and a voice note’s transcript', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale, 'HD-1041');

    const toggle = page.getByRole('button', { name: t('tickets:assist.showRedacted') });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('[EMAIL_1]')).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await openTicket(page, locale, 'HD-1039');
    await page.getByRole('button', { name: t('tickets:assist.transcript.toggle') }).click();
    await expect(page.getByText('وهل يجب أن أدفع رسوم جمارك عند الاستلام في برلين؟')).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
});

test.describe('article proposals', () => {
  test('an agent drafts from a closed ticket; a reviewer cannot reject without a reason, and approves into the editor', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale, 'HD-1030');

    await page.getByRole('button', { name: t('tickets:assist.button') }).click();
    await page
      .getByRole('menuitem', { name: new RegExp(t('tickets:assist.menu.draftArticle')) })
      .click();
    const dialog = page.getByRole('dialog', { name: new RegExp(t('tickets:assist.draft.title')) });
    await expect(dialog.getByLabel(t('tickets:assist.draft.articleTitle'))).toHaveValue(
      /Customs and VAT/,
    );
    expect(await violations(page)).toEqual([]);
    await dialog.getByRole('button', { name: t('tickets:assist.draft.send') }).click();
    await expect(page.getByText(t('tickets:assist.draft.sent'))).toBeVisible();

    await page.getByRole('link', { name: new RegExp(t('admin:nav.helpCenter')) }).click();
    await page.getByRole('tab', { name: new RegExp(t('helpCenter:tabs.proposals')) }).click();
    const review = page.getByRole('region', { name: t('helpCenter:proposals.review') });
    await expect(review.getByRole('heading', { name: /Customs and VAT/ })).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await review.getByRole('button', { name: t('helpCenter:proposals.reject') }).click();
    const reject = page.getByRole('dialog', { name: t('helpCenter:proposals.rejectTitle') });
    await expect(
      reject.getByRole('button', { name: t('helpCenter:proposals.rejectSubmit') }),
    ).toBeDisabled();
    await reject.getByRole('button', { name: t('tickets:assist.draft.cancel') }).click();

    await review.getByRole('button', { name: t('helpCenter:proposals.approve') }).click();
    await expect(page.getByText(t('helpCenter:proposals.approved'))).toBeVisible();
    await expect(page).toHaveURL(/\/help-center\/articles\//);
  });
});
