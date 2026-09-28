import type { Brand, TicketDetail } from '@helpdock/schemas';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { strings } from '../strings.js';
import { E2E_API_ORIGIN, SKIP_ENV } from './install.js';
import {
  adminApi,
  adminRequest,
  allowOrigin,
  type CustomerSite,
  embedTag,
  expect,
  openAdmin,
  replyInWorkspace,
  setAppearance,
  startCustomerSite,
  test,
} from './widget-helpers.js';

/**
 * M4's first exit criterion against the real api: the widget embedded on two
 * origins under two brands, each in its own theme, exchanging messages with
 * agents in the admin.
 *
 * The seeded install has one brand, so the spec adds a second through the
 * install api, as an install admin would, and gives each brand its own accent
 * and its own customer site. Each visitor's launcher is drawn in its brand's
 * accent; each message lands as a ticket of its own brand, which the other
 * brand cannot read; each agent's answer, written in the admin under that
 * brand, reaches that brand's visitor and not the other.
 */

test.skip(
  Boolean(process.env[SKIP_ENV]),
  'Docker is not available, so there is no api to run against.',
);

test.describe.configure({ mode: 'serial' });

const t = strings('en');

interface Side {
  readonly accent: string;
  readonly rgb: string;
  readonly question: string;
  readonly answer: string;
  brand?: Brand;
  site?: CustomerSite;
  visitor?: Page;
  ticketId?: string;
}

const SEEDED: Side = {
  accent: '#1D4ED8',
  rgb: 'rgb(29, 78, 216)',
  question: 'Hello from the first shop: my order 7001 is late.',
  answer: 'First shop here. Your order ships tomorrow.',
};
const SECOND: Side = {
  accent: '#7C3AED',
  rgb: 'rgb(124, 58, 237)',
  question: 'Hello from the second shop: can I change my size?',
  answer: 'Second shop here. Yes, reply with the size you need.',
};
const SECOND_BRAND = { name: 'Second Shop', prefix: 'TWO' } as const;

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) {
    throw new Error(`${what} is not set: an earlier step of this serial spec failed`);
  }
  return value;
};

const openVisitor = async (browser: Browser, side: Side): Promise<BrowserContext> => {
  const context = await browser.newContext();
  side.visitor = await context.newPage();
  return context;
};

/** Switches the admin to `brandName` and opens the ticket from its "All tickets" view. */
const openTicketIn = async (admin: Page, brandName: string, reference: string): Promise<void> => {
  await admin.getByRole('button', { name: t('admin:brandSwitcher.action') }).click();
  await admin.getByRole('menuitemradio', { name: brandName }).click();
  await expect(admin.getByRole('menuitemradio', { name: brandName })).toBeHidden();
  await admin
    .getByRole('link', { name: new RegExp(t('admin:nav.tickets')) })
    .first()
    .click();
  await admin.getByRole('link', { name: t('tickets:views.all'), exact: true }).click();
  await admin.getByRole('link', { name: new RegExp(reference) }).click();
};

test.describe('the widget under two brands on two origins', () => {
  let admin: Page;
  const contexts: BrowserContext[] = [];

  test.beforeAll(async ({ browser, admin: signedIn }) => {
    admin = signedIn;
    for (const side of [SEEDED, SECOND]) {
      side.site = await startCustomerSite(`Shop ${side.accent}`, () =>
        embedTag(E2E_API_ORIGIN, need(side.brand, 'the brand').id),
      );
      contexts.push(await openVisitor(browser, side));
    }
  });

  test.afterAll(async () => {
    await Promise.all(contexts.map((context) => context.close()));
    await Promise.all([SEEDED, SECOND].map((side) => side.site?.close()));
  });

  test('each brand’s widget runs on its own origin in its own accent', async () => {
    await openAdmin(admin);
    const api = adminApi(admin);
    const { brands } = await api<{ brands: Brand[] }>('GET', '/api/brands');
    SEEDED.brand = need(
      brands.find((brand) => brand.prefix === 'HD'),
      'the seeded brand',
    );
    SECOND.brand = await api<Brand>('POST', '/api/install/brands', {
      ...SECOND_BRAND,
      defaultLocale: 'en',
      timezone: 'Europe/London',
    });

    for (const side of [SEEDED, SECOND]) {
      const brandId = need(side.brand, 'the brand').id;
      await setAppearance(api, brandId, {
        accent: side.accent,
        colorScheme: 'light',
        mode: 'chat',
      });
      await allowOrigin(api, brandId, need(side.site, 'the site').origin);
    }

    for (const side of [SEEDED, SECOND]) {
      const visitor = need(side.visitor, 'the visitor');
      await visitor.goto(need(side.site, 'the site').origin);
      await expect(visitor.getByRole('button', { name: t('widget:launcher.open') })).toHaveCSS(
        'background-color',
        side.rgb,
      );
    }
  });

  test('each visitor’s message becomes a ticket of that brand only', async () => {
    for (const side of [SEEDED, SECOND]) {
      const visitor = need(side.visitor, 'the visitor');
      await visitor.getByRole('button', { name: t('widget:launcher.open') }).click();
      const window = visitor.getByRole('region', { name: t('widget:window.label') });
      await window.getByRole('textbox', { name: t('widget:composer.label') }).fill(side.question);
      const started = visitor.waitForResponse(
        (response) =>
          response.request().method() === 'POST' && response.url().endsWith('/conversations'),
      );
      await window.getByRole('button', { name: t('widget:composer.send') }).click();
      side.ticketId = (
        (await (await started).json()) as { conversation: { id: string } }
      ).conversation.id;
      await expect(
        window
          .getByRole('log', { name: t('widget:thread.label') })
          .getByText(t('widget:message.sent')),
      ).toBeVisible();
    }

    const api = adminApi(admin);
    for (const [side, other] of [
      [SEEDED, SECOND],
      [SECOND, SEEDED],
    ] as const) {
      const brandId = need(side.brand, 'the brand').id;
      const { ticket } = await api<TicketDetail>(
        'GET',
        `/api/brands/${brandId}/tickets/${need(side.ticketId, 'the ticket')}`,
      );
      expect(ticket.prefix).toBe(need(side.brand, 'the brand').prefix);
      expect(ticket.channel).toBe('chat');

      const across = await adminRequest(
        admin,
        'GET',
        `/api/brands/${brandId}/tickets/${need(other.ticketId, 'the other ticket')}`,
      );
      expect(across.status()).toBe(404);
    }
  });

  test('an agent answers each in the admin under its brand, and only that visitor sees it', async () => {
    // A reload asks for a new session, which now lists the second brand.
    await openAdmin(admin);
    const api = adminApi(admin);

    for (const side of [SEEDED, SECOND]) {
      const brand = need(side.brand, 'the brand');
      const { ticket } = await api<TicketDetail>(
        'GET',
        `/api/brands/${brand.id}/tickets/${need(side.ticketId, 'the ticket')}`,
      );
      await openTicketIn(admin, brand.name, `${ticket.prefix}-${String(ticket.number)}`);
      const thread = admin.getByRole('list', { name: t('tickets:thread.label') });
      await expect(thread.getByText(side.question)).toHaveCount(1);
      await replyInWorkspace(admin, side.answer);
    }

    for (const [side, other] of [
      [SEEDED, SECOND],
      [SECOND, SEEDED],
    ] as const) {
      const log = need(side.visitor, 'the visitor').getByRole('log', {
        name: t('widget:thread.label'),
      });
      await expect(log.getByText(side.answer)).toBeVisible();
      await expect(log.getByText(other.answer)).toHaveCount(0);
      await expect(log.getByText(other.question)).toHaveCount(0);
    }
  });
});
