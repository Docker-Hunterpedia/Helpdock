import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BrowserContext, Page } from '@playwright/test';
import { strings } from '../strings.js';
import { E2E_API_ORIGIN, SKIP_ENV } from './install.js';
import { expect, openAdmin, test } from './widget-helpers.js';

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
 *
 * Last, M5-10: an article published in the admin is listed in the widget's
 * help center mode, found by its search once the worker has indexed it, and
 * read inside the window.
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

  test.beforeAll(async ({ browser, admin: signedIn }) => {
    admin = signedIn;
    visitorContext = await browser.newContext();
    visitor = await visitorContext.newPage();
  });

  test.afterAll(async () => {
    await visitorContext.close();
  });

  test('a visitor writes from a customer page, the agent answers, the visitor sees it', async () => {
    await openAdmin(admin);
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

  test('an article the agent publishes is listed, found and read in the widget (M5-10)', async () => {
    // Staff: a category, a section and one published article.
    await admin.getByRole('link', { name: new RegExp(t('admin:nav.helpCenter')) }).click();
    await admin.getByRole('button', { name: t('helpCenter:tree.addCategory') }).click();
    let dialog = admin.getByRole('dialog', { name: t('helpCenter:tree.dialog.category') });
    await dialog.getByLabel(t('helpCenter:tree.dialog.english')).fill(CATEGORY);
    await dialog.getByRole('button', { name: t('helpCenter:tree.dialog.create') }).click();
    await admin
      .getByRole('button', { name: t('helpCenter:tree.expand', { name: CATEGORY }) })
      .click();
    await admin.getByRole('button', { name: t('helpCenter:tree.addSection') }).click();
    dialog = admin.getByRole('dialog', { name: t('helpCenter:tree.dialog.section') });
    await dialog.getByLabel(t('helpCenter:tree.dialog.english')).fill(SECTION);
    await dialog.getByRole('button', { name: t('helpCenter:tree.dialog.create') }).click();
    await admin
      .getByRole('button', { name: t('helpCenter:newArticle.label') })
      .first()
      .click();
    const body = admin.getByRole('textbox', { name: t('helpCenter:editor.body') });
    await body.waitFor();
    await admin.getByLabel(t('helpCenter:editor.title'), { exact: true }).fill(ARTICLE_TITLE);
    await body.click();
    await admin.keyboard.type(ARTICLE_BODY);
    await expect(
      admin
        .getByRole('status')
        .filter({ hasText: t('helpCenter:editor.saved', { time: '' }).trim() }),
    ).toBeVisible();
    await admin.getByRole('button', { name: t('helpCenter:editor.publish'), exact: true }).click();
    await expect(
      admin.getByRole('status').filter({ hasText: t('helpCenter:toast.status.published') }),
    ).toBeVisible();

    // The widget in help center mode.
    await admin.getByRole('link', { name: new RegExp(t('admin:nav.channels')) }).click();
    await admin.getByRole('tab', { name: t('channels:tabs.widget') }).click();
    const appearance = admin.getByRole('region', { name: t('channels:widget.appearance.heading') });
    await appearance
      .getByRole('radio', {
        name: new RegExp(t('channels:widget.appearance.modes.helpcenter.label')),
      })
      .check();
    await appearance.getByRole('button', { name: t('channels:widget.save') }).click();
    await expect(
      admin.getByRole('status').filter({ hasText: t('channels:widget.appearance.saved') }),
    ).toBeVisible();

    // The visitor: listed from the config, then found by search once the
    // worker's subscriber has indexed it, then read inside the window.
    await visitor.reload();
    await visitor.getByRole('button', { name: t('widget:launcher.open') }).click();
    const window = visitor.getByRole('region', { name: t('widget:window.label') });
    await expect(
      window.getByRole('list', { name: t('widget:articles.popular') }).getByText(ARTICLE_TITLE),
    ).toBeVisible();

    const search = window.getByRole('searchbox', { name: t('widget:articles.searchLabel') });
    const results = window.getByRole('list', { name: t('widget:articles.resultsLabel') });
    await expect(async () => {
      await search.fill('');
      await search.fill('courier');
      await expect(results.getByText(ARTICLE_TITLE)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    await results.getByRole('link', { name: new RegExp(ARTICLE_TITLE) }).click();
    await expect(window.getByText(ARTICLE_BODY)).toBeVisible();
  });
});

const CATEGORY = 'Orders';
const SECTION = 'Tracking';
const ARTICLE_TITLE = 'Where is my parcel?';
const ARTICLE_BODY = 'Every parcel is handed to the courier within two working days.';
