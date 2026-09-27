import type { Brand } from '@helpdock/schemas';
import type { BrowserContext, Page } from '@playwright/test';
import { strings } from '../strings.js';
import { type ApiReplica, SKIP_ENV, startApiReplica } from './install.js';
import {
  adminApi,
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
 * The api-restart third of M4's delivery exit criterion, in a browser: a
 * message that reached the api as it died, and an agent's answer written
 * while it was down, both end up in the widget exactly once after the api
 * comes back, without the visitor pressing anything.
 *
 * The widget here talks to an api replica of its own (`startApiReplica`),
 * which the spec kills and starts again. The agent works in the admin
 * against the api every other spec shares, which stays up throughout, as a
 * second replica would in production.
 */

test.skip(
  Boolean(process.env[SKIP_ENV]),
  'Docker is not available, so there is no api to run against.',
);

test.describe.configure({ mode: 'serial' });

const t = strings('en');

const REPLICA_PORT = Number(process.env.HD_E2E_REPLICA_API_PORT ?? 3097);

const FIRST = 'Hi, the tracking page for order 9310 shows nothing.';
const CUT_OFF = 'It has said "label created" for a week.';
const MEANWHILE = 'I have asked the courier to trace it and will write back today.';

test.describe('the widget across an api restart', () => {
  let replica: ApiReplica | undefined;
  let site: CustomerSite;
  let admin: Page;
  let visitorContext: BrowserContext;
  let visitor: Page;
  let brandId = '';

  test.beforeAll(async ({ browser, admin: signedIn }) => {
    replica = await startApiReplica(REPLICA_PORT);
    site = await startCustomerSite('Parcel shop', () => embedTag(replica?.origin ?? '', brandId));
    admin = signedIn;
    visitorContext = await browser.newContext();
    visitor = await visitorContext.newPage();
  });

  test.afterAll(async () => {
    await visitorContext.close();
    await site.close();
    await replica?.kill();
  });

  test('a send the api died under lands once, and the widget catches up when it is back', async () => {
    await openAdmin(admin);
    const api = adminApi(admin);
    const { brands } = await api<{ brands: Brand[] }>('GET', '/api/brands');
    brandId = brands.find((brand) => brand.prefix === 'HD')?.id ?? '';
    await setAppearance(api, brandId, { mode: 'chat' });
    await allowOrigin(api, brandId, site.origin);

    await visitor.goto(site.origin);
    await visitor.getByRole('button', { name: t('widget:launcher.open') }).click();
    const window = visitor.getByRole('region', { name: t('widget:window.label') });
    const log = window.getByRole('log', { name: t('widget:thread.label') });
    const composer = window.getByRole('textbox', { name: t('widget:composer.label') });
    const send = window.getByRole('button', { name: t('widget:composer.send') });

    const started = visitor.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/conversations'),
    );
    await composer.fill(FIRST);
    await send.click();
    const ticketId = ((await (await started).json()) as { conversation: { id: string } })
      .conversation.id;
    await expect(log.getByText(t('widget:message.sent'))).toBeVisible();

    // The next send reaches the api, which commits it and dies before its
    // answer leaves: the widget sees a connection that went away.
    let died = false;
    await visitor.route('**/api/widget/*/conversations/*/messages', async (route) => {
      if (route.request().method() !== 'POST' || died) {
        await route.continue();
        return;
      }
      await route.fetch();
      await replica?.kill();
      died = true;
      await route.abort('connectionreset');
    });
    await composer.fill(CUT_OFF);
    await send.click();
    await expect.poll(() => died).toBe(true);
    await expect(window.getByText(t('widget:connection.reconnectingTitle'))).toBeVisible();

    // While the widget's api is down, the agent answers through the other one.
    await admin.goto(`/tickets/${ticketId}`);
    await replyInWorkspace(admin, MEANWHILE);

    replica = await startApiReplica(REPLICA_PORT);

    await expect(log.getByText(MEANWHILE)).toBeVisible({ timeout: 30_000 });
    await expect(log.getByText(CUT_OFF)).toHaveCount(1);
    await expect(log.getByText(t('widget:message.notSent'))).toHaveCount(0, { timeout: 15_000 });
    await expect(log.getByText(t('widget:message.sent')).last()).toBeVisible();

    await admin.reload();
    const thread = admin.getByRole('list', { name: t('tickets:thread.label') });
    await expect(thread.getByText(MEANWHILE)).toBeVisible();
    await expect(thread.getByText(CUT_OFF)).toHaveCount(1);
  });
});
