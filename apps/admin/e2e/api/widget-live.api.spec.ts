import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { generate } from 'otplib';
import { strings } from '../strings.js';
import {
  ACCOUNT_EMAIL_ENV,
  ACCOUNT_PASSWORD_ENV,
  E2E_API_ORIGIN,
  SKIP_ENV,
  TOTP_SECRET_ENV,
} from './install.js';

/**
 * The widget end to end against the real api (M4-01, M4-04): the built
 * `widget.js`, served by the api, embedded with the Channels › Widget tag on
 * a customer page of its own origin, talking to a real Postgres and Redis.
 *
 * A visitor writes, the agent sees it in the ticket and answers, the visitor
 * sees the answer. Then M4's delivery exit criterion, in a browser: the
 * network drops while a message is on its way, the request that did reach
 * the api is submitted twice, and when the network comes back the widget
 * holds exactly one copy — as does the ticket — and has caught up on the
 * reply the agent wrote meanwhile, without the visitor pressing anything.
 */

test.skip(
  Boolean(process.env[SKIP_ENV]),
  'Docker is not available, so there is no api to run against.',
);

test.describe.configure({ mode: 'serial' });

const t = strings('en');

const FIRST = 'Hello, my parcel 5521 has not arrived yet.';
const ANSWER = 'Sorry about that. I am checking with the courier now.';
const SECOND = 'Thanks. It was due on Monday.';
const MEANWHILE = 'The courier says it is out for delivery today.';

/** The customer's site: one page on its own origin, with the embed tag and nothing else. */
let site: Server;
let siteOrigin = '';
let embedTag = '';

test.beforeAll(async () => {
  site = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title></head><body><h1>Shop</h1>${embedTag}</body></html>`,
    );
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  siteOrigin = `http://127.0.0.1:${String((site.address() as AddressInfo).port)}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => site.close(resolve));
});

const signInAsAdmin = async (page: Page): Promise<void> => {
  await page.goto('/sign-in');
  await page.getByLabel(t('auth:signIn.emailLabel')).fill(process.env[ACCOUNT_EMAIL_ENV] ?? '');
  await page
    .getByLabel(t('auth:signIn.passwordLabel'))
    .fill(process.env[ACCOUNT_PASSWORD_ENV] ?? '');
  await page.getByRole('button', { name: t('auth:signIn.submit'), exact: true }).click();
  await page
    .getByLabel(t('auth:totp.codeLabel'))
    .fill(await generate({ secret: process.env[TOTP_SECRET_ENV] ?? '' }));
  await page.getByRole('button', { name: t('auth:totp.submit') }).click();
  await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();
};

/** The Channels › Widget tag for this install, with the site's origin allowed. */
const embedFor = async (page: Page, origin: string): Promise<string> => {
  await page.getByRole('link', { name: new RegExp(t('admin:nav.channels')) }).click();
  await page.getByRole('tab', { name: t('channels:tabs.widget') }).click();
  const snippet =
    (await page
      .getByRole('region', { name: t('channels:widget.embed.heading') })
      .locator('pre')
      .textContent()) ?? '';

  const access = page.getByRole('region', { name: t('channels:widget.access.heading') });
  await access.getByRole('textbox', { name: t('channels:widget.access.addLabel') }).fill(origin);
  await access.getByRole('button', { name: t('channels:widget.access.add') }).click();
  await access.getByRole('button', { name: t('channels:widget.save') }).click();
  await expect(
    page.getByRole('status').filter({ hasText: t('channels:widget.access.saved') }),
  ).toBeVisible();

  // The tag names the admin's origin, which is the api's in production. Here
  // the admin is a Vite dev server in front of the api, so the script is
  // fetched from the api directly.
  return snippet.replace(/src="[^"]*\/widget\.js"/, `src="${E2E_API_ORIGIN}/widget.js"`);
};

const replyAsAgent = async (page: Page, ticketId: string, text: string): Promise<void> => {
  await page.goto(`/tickets/${ticketId}`);
  await page.getByRole('list', { name: t('tickets:thread.label') }).waitFor();
  await page.getByRole('textbox', { name: t('tickets:composer.bodyLabel') }).fill(text);
  await page.getByRole('button', { name: t('tickets:composer.send') }).click();
  await expect(
    page.getByRole('status').filter({ hasText: t('tickets:toast.replied') }),
  ).toBeVisible();
};

test.describe('the widget against the real api', () => {
  let admin: Page;
  let visitorContext: BrowserContext;
  let visitor: Page;
  let ticketId = '';

  test.beforeAll(async ({ browser }) => {
    admin = await browser.newPage();
    visitorContext = await browser.newContext();
    visitor = await visitorContext.newPage();
  });

  test.afterAll(async () => {
    await admin.close();
    await visitorContext.close();
  });

  test('a visitor writes from a customer page, the agent answers, the visitor sees it', async () => {
    await signInAsAdmin(admin);
    embedTag = await embedFor(admin, siteOrigin);
    expect(embedTag).toMatch(
      /^<script type="module" src="[^"]+" data-brand="[0-9a-f-]{36}"><\/script>$/,
    );

    await visitor.goto(siteOrigin);
    await visitor.getByRole('button', { name: t('widget:launcher.open') }).click();
    const window = visitor.getByRole('region', { name: t('widget:window.label') });
    const log = window.getByRole('log', { name: t('widget:thread.label') });
    await window.getByRole('textbox', { name: t('widget:composer.label') }).fill(FIRST);
    const started = visitor.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/conversations'),
    );
    await window.getByRole('button', { name: t('widget:composer.send') }).click();
    ticketId = ((await (await started).json()) as { conversation: { id: string } }).conversation.id;

    await expect(log.getByText(FIRST)).toBeVisible();
    await expect(log.getByText(t('widget:message.sent'))).toBeVisible();

    await replyAsAgent(admin, ticketId, ANSWER);
    const thread = admin.getByRole('list', { name: t('tickets:thread.label') });
    await expect(thread.getByText(FIRST)).toHaveCount(1);

    // Pushed over the `/widget` socket; nobody reloads the page.
    await expect(log.getByText(ANSWER)).toBeVisible();
  });

  test('a send cut off mid-flight and submitted twice lands once, and the widget catches up by itself', async () => {
    let cut = false;
    await visitor.route('**/api/widget/*/conversations/*/messages', async (route) => {
      if (route.request().method() !== 'POST' || cut) {
        await route.continue();
        return;
      }
      cut = true;
      // The request reaches the api twice — a double submit with one
      // `clientId` — and then the network goes, so neither answer arrives.
      await route.fetch();
      await route.fetch();
      await visitorContext.setOffline(true);
      await route.abort('internetdisconnected');
    });

    const window = visitor.getByRole('region', { name: t('widget:window.label') });
    const log = window.getByRole('log', { name: t('widget:thread.label') });
    await window.getByRole('textbox', { name: t('widget:composer.label') }).fill(SECOND);
    await window.getByRole('button', { name: t('widget:composer.send') }).click();
    await expect.poll(() => cut).toBe(true);
    await expect(window.getByText(t('widget:connection.reconnectingTitle'))).toBeVisible();

    // While the visitor is away, the agent answers: an event the socket cannot deliver.
    await replyAsAgent(admin, ticketId, MEANWHILE);

    await visitorContext.setOffline(false);

    await expect(log.getByText(MEANWHILE)).toBeVisible({ timeout: 20_000 });
    await expect(log.getByText(SECOND)).toHaveCount(1);
    await expect(log.getByText(t('widget:message.notSent'))).toHaveCount(0);
    await expect(log.getByText(t('widget:message.sent')).last()).toBeVisible();

    await admin.reload();
    const thread = admin.getByRole('list', { name: t('tickets:thread.label') });
    await expect(thread.getByText(MEANWHILE)).toBeVisible();
    await expect(thread.getByText(SECOND)).toHaveCount(1);
  });
});
