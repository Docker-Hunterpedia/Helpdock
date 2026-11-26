import AxeBuilder from '@axe-core/playwright';
import { createI18n } from '@helpdock/i18n';
import { type BrowserContext, test as base, expect, type Page } from '@playwright/test';
import { HELP_CENTER_PORTAL_URL } from './fixtures.ts';
import {
  PORTAL_MANAGER,
  PORTAL_OWN_ONLY,
  portalMonaFor,
  TICKET_COWORKER,
  TICKET_COWORKER_PRIVATE,
  TICKET_MINE,
  TICKET_PRIVATE,
  TICKET_SOLVED,
  TICKET_STRANGER,
  TICKET_WAITING_US,
} from './portal-fixtures.ts';

/**
 * "My tickets" and the ticket page (M21-03; artboards `HelpCenter/Portal-Tickets`
 * and `HelpCenter/Portal-Ticket`, the read side) in a real browser, in both
 * languages, over the Playwright server's in-memory store: sign in, read the
 * list, open a ticket and its messages and files, go back, the company view, the
 * empty state, search, and the 404 for a ticket that is not the customer's.
 * Every page goes through axe. What the same pages do against Postgres and
 * row-level security is `portal-tickets.integration.test.ts`.
 *
 * The file runs serially so each language signs in once per customer: the
 * server allows five link requests per address.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';
const BASE = `/hc/${BRAND}`;

const test = base.extend<{ pageLocale: 'en' | 'ar' }>({
  pageLocale: ['en', { option: true }],
});

test.use({ reducedMotion: 'reduce', baseURL: HELP_CENTER_PORTAL_URL });
test.describe.configure({ mode: 'serial' });

const strings = (locale: 'en' | 'ar') => {
  const t = createI18n({ lng: locale }).getFixedT(locale, 'hcSite');
  return (key: string, options?: Record<string, unknown>): string =>
    (t as unknown as (key: string, options?: Record<string, unknown>) => string)(key, options);
};

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map(
    (violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`,
  );
}

const emailedLink = async (page: Page, email: string): Promise<string> => {
  const response = await page.request.get(`/__e2e/link?email=${encodeURIComponent(email)}`);
  const { url } = (await response.json()) as { url: string | null };
  expect(url, `a link for ${email}`).not.toBeNull();
  const link = new URL(url ?? '');
  return `${link.pathname}${link.search}`;
};

/** Asks for a link, follows it and presses Continue: the real flow, ending on the list. */
const signIn = async (page: Page, locale: 'en' | 'ar', email: string): Promise<void> => {
  const t = strings(locale);
  await page.goto(`${BASE}/sign-in?lang=${locale}`);
  await page.getByLabel(t('portal.signIn.email')).fill(email);
  await page.getByRole('button', { name: t('portal.signIn.submit') }).click();
  await expect(page.getByRole('heading', { level: 1, name: t('portal.sent.title') })).toBeVisible();
  await page.goto(await emailedLink(page, email));
  await page.getByRole('button', { name: t('portal.confirm.submit') }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE}/tickets\\?lang=${locale}$`));
};

const rowFor = (page: Page, reference: string) =>
  page.getByRole('listitem').filter({ hasText: reference });

test.describe('a member of a company that shows every ticket', () => {
  let session: Awaited<ReturnType<BrowserContext['cookies']>> = [];

  // One sign-in for the group: the server allows five link requests per address.
  test.beforeAll(async ({ browser, pageLocale }) => {
    const context = await browser.newContext({ baseURL: HELP_CENTER_PORTAL_URL });
    const page = await context.newPage();
    await signIn(page, pageLocale, portalMonaFor(pageLocale));
    session = await context.cookies();
    await context.close();
  });

  test.beforeEach(async ({ context, page, pageLocale }) => {
    await context.addCookies(session);
    await page.goto(`${BASE}/tickets?lang=${pageLocale}`);
  });

  test('lists their tickets with the four statuses, Only you and the company notice', async ({
    page,
    pageLocale,
  }) => {
    const t = strings(pageLocale);
    await expect(page.locator('html')).toHaveAttribute('dir', pageLocale === 'ar' ? 'rtl' : 'ltr');
    await expect(
      page.getByRole('heading', { level: 1, name: t('portal.nav.tickets') }),
    ).toBeVisible();
    // "My tickets" is the current item of the header.
    await expect(
      page.getByRole('banner').getByRole('link', { name: t('portal.nav.tickets') }),
    ).toHaveAttribute('aria-current', 'page');

    await expect(rowFor(page, TICKET_MINE.reference)).toContainText(t('portal.status.waiting_you'));
    await expect(rowFor(page, TICKET_WAITING_US.reference)).toContainText(
      t('portal.status.waiting_us'),
    );
    await expect(rowFor(page, TICKET_PRIVATE.reference)).toContainText(t('portal.list.onlyYou'));
    await expect(rowFor(page, TICKET_PRIVATE.reference)).toContainText(t('portal.status.open'));
    await expect(page.getByText(TICKET_SOLVED.subject)).toHaveCount(0);
    await expect(page.getByText(TICKET_COWORKER.subject)).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText(
      t('portal.list.noticeAll', { company: 'Acme Trading' }),
    );
    // The notice cannot be dismissed, and New ticket is M21-04's.
    await expect(page.getByRole('status').getByRole('button')).toHaveCount(0);
    await expect(page.getByText(/New ticket|تذكرة جديدة/)).toHaveCount(0);

    // A row is one link, named by its subject, its reference and its status.
    const link = page.getByRole('link', { name: new RegExp(TICKET_MINE.reference) });
    await expect(link).toHaveAccessibleName(
      new RegExp(
        `${TICKET_MINE.subject}.*${TICKET_MINE.reference}.*${t('portal.status.waiting_you')}`,
      ),
    );
    expect(await violations(page)).toEqual([]);
  });

  test('opens a ticket, reads its messages and a file, and goes back', async ({
    page,
    pageLocale,
  }) => {
    const t = strings(pageLocale);
    await rowFor(page, TICKET_MINE.reference).getByRole('link').click();

    await expect(page).toHaveURL(new RegExp(`${BASE}/tickets/${TICKET_MINE.reference}\\?lang=`));
    await expect(page.getByRole('heading', { level: 1, name: TICKET_MINE.subject })).toBeFocused();
    await expect(page.getByRole('main')).toContainText(TICKET_MINE.reference);
    await expect(page.getByRole('main')).toContainText(t('portal.status.waiting_you'));
    await expect(page.getByRole('main')).toContainText(t('portal.channel.email'));
    const articles = page.getByRole('article');
    await expect(articles).toHaveCount(2);
    await expect(articles.first()).toContainText(t('portal.ticket.you'));
    await expect(articles.first()).toContainText('no refund on my card');
    await expect(articles.nth(1)).toContainText(t('portal.ticket.support'));
    await expect(articles.nth(1)).toContainText(
      t('portal.ticket.from', { name: 'Lina', brand: 'Helpdock' }),
    );
    await expect(articles.first().getByRole('link', { name: TICKET_MINE.file })).toBeVisible();
    // Nothing of M21-04: no reply box, attach, mark as solved or rating.
    await expect(page.getByRole('main').getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('main').getByRole('button')).toHaveCount(0);
    expect(await violations(page)).toEqual([]);

    // The file opens through its authorised address.
    const file = await page.request.get(
      `${BASE}/tickets/${TICKET_MINE.reference}/attachments/${TICKET_MINE.fileId}`,
    );
    expect(file.status()).toBe(200);
    expect(await file.text()).toContain(TICKET_MINE.file);

    await page
      .getByRole('link', { name: t('portal.ticket.back') })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/tickets\\?lang=${pageLocale}$`));
    await expect(rowFor(page, TICKET_MINE.reference)).toBeVisible();
  });

  test('switches to the company: who opened each ticket, a coworker’s ticket read-only, no private ones', async ({
    page,
    pageLocale,
  }) => {
    const t = strings(pageLocale);
    await page
      .getByRole('link', { name: /Acme Trading/ })
      .first()
      .click();

    await expect(page).toHaveURL(/scope=company/);
    await expect(page.getByRole('link', { name: /Acme Trading/ }).first()).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(rowFor(page, TICKET_COWORKER.reference)).toContainText(
      t('portal.list.openedBy', { name: 'Omar Saleh' }),
    );
    await expect(rowFor(page, TICKET_MINE.reference)).toContainText(t('portal.list.openedByYou'));
    await expect(page.getByText(TICKET_COWORKER_PRIVATE.subject)).toHaveCount(0);
    await expect(page.getByText(TICKET_STRANGER.subject)).toHaveCount(0);
    expect(await violations(page)).toEqual([]);

    await rowFor(page, TICKET_COWORKER.reference).getByRole('link').click();
    await expect(
      page.getByRole('heading', { level: 1, name: TICKET_COWORKER.subject }),
    ).toBeVisible();
    await expect(page.getByRole('main')).toContainText('Omar Saleh');
    await expect(page.getByRole('article').first()).toContainText('Omar Saleh');
    await expect(page.getByRole('article').first()).toContainText(t('portal.ticket.coworker'));
    expect(await violations(page)).toEqual([]);
  });

  test('splits Open and Solved, and searches by subject and reference without script', async ({
    page,
    pageLocale,
  }) => {
    const t = strings(pageLocale);
    await page.getByRole('link', { name: t('portal.list.solved'), exact: true }).click();
    await expect(rowFor(page, TICKET_SOLVED.reference)).toContainText(t('portal.status.solved'));
    await expect(page.getByText(TICKET_MINE.subject)).toHaveCount(0);

    await page.getByRole('link', { name: t('portal.list.open'), exact: true }).click();
    const search = page.getByRole('searchbox', { name: t('portal.list.searchLabel') });
    await search.fill('refund');
    await search.press('Enter');
    await expect(page).toHaveURL(/q=refund/);
    await expect(rowFor(page, TICKET_MINE.reference)).toBeVisible();
    await expect(page.getByText(TICKET_WAITING_US.subject)).toHaveCount(0);

    await search.fill(TICKET_WAITING_US.reference.toLowerCase());
    await search.press('Enter');
    await expect(rowFor(page, TICKET_WAITING_US.reference)).toBeVisible();
    await expect(page.getByText(TICKET_MINE.subject)).toHaveCount(0);

    await search.fill('no such ticket');
    await search.press('Enter');
    await expect(page.getByRole('heading', { level: 2 })).toContainText(
      t('portal.list.emptySearchTitle', { q: 'no such ticket' }),
    );
    expect(await violations(page)).toEqual([]);
  });

  test('answers a ticket that is not theirs with the help center’s not-found page, never "forbidden"', async ({
    page,
    pageLocale,
  }) => {
    const t = strings(pageLocale);
    for (const ticket of [TICKET_STRANGER, TICKET_COWORKER_PRIVATE, { reference: 'HD-9999' }]) {
      const response = await page.goto(`${BASE}/tickets/${ticket.reference}?lang=${pageLocale}`);
      expect(response?.status()).toBe(404);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(
        t('states.notFound.heading'),
      );
      await expect(page.getByRole('main')).not.toContainText(/forbidden|403|ممنوع/i);
      await expect(page.getByRole('main')).not.toContainText('Not Acme at all');
    }
    expect(await violations(page)).toEqual([]);

    const file = await page.request.get(
      `${BASE}/tickets/${TICKET_STRANGER.reference}/attachments/${TICKET_MINE.fileId}`,
    );
    expect(file.status()).toBe(404);
  });
});

test('a manager reads the company and is told why', async ({ page, pageLocale }) => {
  const t = strings(pageLocale);
  await signIn(page, pageLocale, PORTAL_MANAGER);
  await page.goto(`${BASE}/tickets?lang=${pageLocale}&scope=company`);

  await expect(page.getByRole('status')).toContainText(
    t('portal.list.noticeManager', { company: 'Acme Trading' }),
  );
  expect(await violations(page)).toEqual([]);
});

test('a customer whose company shows only their own tickets gets no switch and no notice', async ({
  page,
  pageLocale,
}) => {
  const t = strings(pageLocale);
  await signIn(page, pageLocale, PORTAL_OWN_ONLY);
  await expect(page.getByRole('group', { name: t('portal.list.stateLabel') })).toHaveCount(1);
  await expect(page.getByRole('group', { name: t('portal.list.scopeLabel') })).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(0);
  await page.goto(`${BASE}/tickets?lang=${pageLocale}&scope=company`);
  await expect(page.getByText(TICKET_COWORKER.subject)).toHaveCount(0);
});

test('a new customer with no tickets sees the empty state, and Solved is empty too', async ({
  page,
  pageLocale,
}) => {
  const t = strings(pageLocale);
  await signIn(page, pageLocale, `new-${pageLocale}@fresh.example`);

  await expect(page.getByRole('heading', { level: 2 })).toContainText(
    t('portal.list.emptyOpenTitle'),
  );
  await expect(page.getByRole('main')).toContainText(t('portal.list.emptyOpenBody'));
  await expect(page.getByRole('main').getByRole('button')).toHaveCount(0);
  expect(await violations(page)).toEqual([]);

  await page.getByRole('link', { name: t('portal.list.solved'), exact: true }).click();
  await expect(page.getByRole('heading', { level: 2 })).toContainText(
    t('portal.list.emptySolvedTitle'),
  );
});

test('a visitor who opens a ticket address is sent to sign in', async ({ page, pageLocale }) => {
  await page.goto(`${BASE}/tickets/${TICKET_MINE.reference}?lang=${pageLocale}`);
  await expect(page).toHaveURL(/\/sign-in/);
});
