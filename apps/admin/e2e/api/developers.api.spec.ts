import type { Page } from '@playwright/test';
import { strings } from '../strings.js';
import { expect, openAdmin, test } from './admin-session.js';
import { SKIP_ENV } from './install.js';

/**
 * M8-01 and M8-03 against the real api: an API key created on the Developers
 * page answers `/api/v1` with the key it showed once and is refused after
 * Revoke, and a webhook endpoint is refused for a private address and for
 * plain http, then added and sent a test ping through the worker.
 *
 * The mock suite covers the screens in both languages. What this adds is the
 * key hash, the destination check that resolves the endpoint's name, and the
 * `ping` going through the outbox and the `webhook.deliver` job.
 *
 * One page for the whole file, from the worker's signed-in context
 * (`admin-session.ts`): the second test carries on from the Developers page
 * the first one left open.
 */

test.skip(
  Boolean(process.env[SKIP_ENV]),
  'Docker is not available, so there is no api to run against.',
);

test.describe.configure({ mode: 'serial' });

const t = strings('en');
const RUN = String(Date.now()).slice(-6);
const KEY_NAME = `Order sync ${RUN}`;
const ENDPOINT = `https://hooks.example.com/helpdock/${RUN}`;

let page: Page;

const openDevelopers = async (): Promise<void> => {
  await page.getByRole('link', { name: t('admin:nav.developers'), exact: true }).click();
  await page.getByRole('heading', { level: 1, name: t('developers:title') }).waitFor();
};

test.beforeAll(async ({ adminContext }) => {
  page = await adminContext.newPage();
  await openAdmin(page);
});

test.afterAll(async () => {
  await page.close();
});

test('an API key shown once answers /api/v1, and is refused once revoked', async () => {
  await openDevelopers();

  await page
    .getByRole('button', { name: t('developers:keys.create') })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: t('developers:keys.dialog.title') });
  await dialog.getByLabel(t('developers:keys.dialog.name')).fill(KEY_NAME);
  await dialog.getByRole('checkbox', { name: 'tickets:read' }).check();
  await dialog.getByRole('button', { name: t('developers:keys.dialog.submit') }).click();

  const reveal = page.getByRole('dialog', { name: t('developers:keys.reveal.title') });
  const key = await reveal.getByLabel(KEY_NAME).inputValue();
  expect(key).toMatch(/^hd_live_/);
  await reveal.getByRole('button', { name: t('developers:done') }).click();

  const asKey = { headers: { authorization: `Bearer ${key}` } };
  expect((await page.request.get('/api/v1/tickets', asKey)).status()).toBe(200);

  await page
    .getByRole('button', { name: t('developers:keys.revokeLabel', { name: KEY_NAME }) })
    .click();
  await page
    .getByRole('dialog', { name: t('developers:keys.revokeConfirm.title', { name: KEY_NAME }) })
    .getByRole('button', { name: t('developers:keys.revokeConfirm.action') })
    .click();
  await expect(
    page.getByText(t('developers:keys.toast.revoked', { name: KEY_NAME })),
  ).toBeVisible();

  expect((await page.request.get('/api/v1/tickets', asKey)).status()).toBe(401);
});

test('an endpoint is refused for a private address and plain http, then added and pinged', async () => {
  await page.getByRole('tab', { name: t('developers:tabs.webhooks') }).click();
  await page
    .getByRole('button', { name: t('developers:webhooks.add') })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: t('developers:webhooks.form.addTitle') });
  const url = dialog.getByLabel(t('developers:webhooks.form.url'));
  const submit = dialog.getByRole('button', { name: t('developers:webhooks.add') });
  await dialog.getByRole('checkbox', { name: 'ticket.created' }).check();

  await url.fill('https://10.0.4.12/hooks');
  await submit.click();
  await expect(
    dialog.getByText(
      t('developers:webhooks.refusals.webhook-destination-blocked', { address: '10.0.4.12' }),
    ),
  ).toBeVisible();

  await url.fill('http://93.184.216.34/hooks');
  await submit.click();
  await expect(
    dialog.getByText(t('developers:webhooks.refusals.webhook-https-required')),
  ).toBeVisible();

  await url.fill(ENDPOINT);
  await submit.click();
  const reveal = page.getByRole('dialog', { name: t('developers:webhooks.created.title') });
  await expect(reveal.getByLabel(t('developers:webhooks.created.secretLabel'))).toHaveValue(
    /^whsec_/,
  );
  await reveal.getByRole('button', { name: t('developers:webhooks.test.send') }).click();
  // Whether example.com answers depends on the network the run has; that the
  // worker attempted the ping, and recorded what happened, does not.
  await expect(reveal.getByText(/^ping (delivered|failed)/)).toBeVisible({ timeout: 30_000 });
  await reveal.getByRole('button', { name: t('developers:done') }).click();

  await expect(page.getByRole('heading', { level: 2, name: ENDPOINT })).toBeVisible();
  const log = page.getByRole('table', {
    name: t('developers:webhooks.log.tableLabel', { url: ENDPOINT }),
  });
  await expect(log.getByText('ping')).toBeVisible();
});
