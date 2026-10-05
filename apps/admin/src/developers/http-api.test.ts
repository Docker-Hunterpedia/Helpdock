import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { isWebhooksError } from './api.js';
import { HttpDevelopersApi } from './http-api.js';

/**
 * The Developers adapter against a stubbed `fetch`: the paths and bodies it
 * sends, what it parses, and what a refusal becomes. That the routes behave is
 * `api-v1.integration.test.ts` in the api.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const KEY = '0192c3f0-1a2b-7c3d-8e4f-0000000000c1';
const HOOK = '0192c3f0-1a2b-7c3d-8e4f-0000000000e1';
const DELIVERY = '0192c3f0-1a2b-7c3d-8e4f-0000000000d1';
const AT = '2026-10-05T10:00:00.000Z';

const apiKey = {
  id: KEY,
  name: 'CRM',
  prefix: 'hd_live_abcd',
  scopes: ['tickets:read'],
  rateLimitPerMinute: 600,
  createdAt: AT,
  lastUsedAt: null,
  revokedAt: null,
  createdByName: 'Lina',
  revokedByName: null,
};

const webhook = {
  id: HOOK,
  url: 'https://hooks.example.com/helpdock',
  description: '',
  events: ['ticket.created'],
  enabled: true,
  disabledReason: null,
  consecutiveFailures: 0,
  secretRotatedAt: null,
  createdAt: AT,
  updatedAt: AT,
};

const delivery = {
  id: DELIVERY,
  webhookId: HOOK,
  eventId: DELIVERY,
  event: 'ping',
  status: 'pending',
  attempts: 0,
  responseStatus: null,
  responseExcerpt: null,
  durationMs: null,
  error: null,
  replayOf: null,
  createdAt: AT,
  lastAttemptAt: null,
  deliveredAt: null,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
let api: HttpDevelopersApi;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = new HttpDevelopersApi(new HttpTransport());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lastCall = (): { url: string; method: string; body: unknown } => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return {
    url,
    method: init.method ?? 'GET',
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
  };
};

describe('HttpDevelopersApi', () => {
  it('lists, creates and revokes API keys', async () => {
    fetchMock.mockResolvedValueOnce(json({ keys: [apiKey] }));
    expect((await api.apiKeys(BRAND)).keys[0]?.createdByName).toBe('Lina');
    expect(lastCall()).toMatchObject({ url: `/api/brands/${BRAND}/api-keys`, method: 'GET' });

    fetchMock.mockResolvedValueOnce(json({ ...apiKey, key: `hd_live_${'a'.repeat(43)}` }, 201));
    await api.createApiKey(BRAND, { name: 'CRM', scopes: ['tickets:read'] });
    expect(lastCall()).toMatchObject({ method: 'POST', body: { name: 'CRM' } });

    fetchMock.mockResolvedValueOnce(json({ ...apiKey, revokedAt: AT }));
    await api.revokeApiKey(BRAND, KEY);
    expect(lastCall()).toMatchObject({
      method: 'DELETE',
      url: `/api/brands/${BRAND}/api-keys/${KEY}`,
    });
  });

  it('manages endpoints, tests one, and reads and replays its deliveries', async () => {
    const base = `/api/brands/${BRAND}/webhooks`;

    fetchMock.mockResolvedValueOnce(
      json({
        webhooks: [
          {
            ...webhook,
            createdByName: null,
            last24h: { total: 0, succeeded: 0 },
            lastDelivery: null,
          },
        ],
      }),
    );
    await api.webhooks(BRAND);
    expect(lastCall()).toMatchObject({ url: base, method: 'GET' });

    fetchMock.mockResolvedValueOnce(json({ ...webhook, secret: 'whsec_x' }, 201));
    await api.createWebhook(BRAND, { url: webhook.url, events: ['ticket.created'] });
    expect(lastCall()).toMatchObject({ method: 'POST', body: { url: webhook.url } });

    fetchMock.mockResolvedValueOnce(json({ ...webhook, enabled: false }));
    await api.updateWebhook(BRAND, HOOK, { enabled: false });
    expect(lastCall()).toMatchObject({ method: 'PATCH', url: `${base}/${HOOK}` });

    fetchMock.mockResolvedValueOnce(json({ ...webhook, secret: 'whsec_y' }));
    await api.rotateWebhookSecret(BRAND, HOOK);
    expect(lastCall()).toMatchObject({ method: 'POST', url: `${base}/${HOOK}/rotate-secret` });

    fetchMock.mockResolvedValueOnce(json(delivery, 202));
    expect((await api.sendTestEvent(BRAND, HOOK)).event).toBe('ping');
    expect(lastCall()).toMatchObject({ method: 'POST', url: `${base}/${HOOK}/test` });

    fetchMock.mockResolvedValueOnce(json({ deliveries: [delivery], nextCursor: null }));
    await api.deliveries(BRAND, HOOK, DELIVERY);
    expect(lastCall().url).toBe(`${base}/${HOOK}/deliveries?cursor=${DELIVERY}`);

    fetchMock.mockResolvedValueOnce(
      json({ ...delivery, request: { method: 'POST', url: webhook.url, headers: [], body: '{}' } }),
    );
    await api.delivery(BRAND, HOOK, DELIVERY);
    expect(lastCall().url).toBe(`${base}/${HOOK}/deliveries/${DELIVERY}`);

    fetchMock.mockResolvedValueOnce(json({ ...delivery, replayOf: DELIVERY }));
    await api.replayDelivery(BRAND, HOOK, DELIVERY);
    expect(lastCall()).toMatchObject({
      method: 'POST',
      url: `${base}/${HOOK}/deliveries/${DELIVERY}/replay`,
    });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.removeWebhook(BRAND, HOOK);
    expect(lastCall()).toMatchObject({ method: 'DELETE', url: `${base}/${HOOK}` });
  });

  it('turns a webhook refusal into a WebhooksError carrying the address', async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            code: 'validation_failed',
            message: 'private',
            requestId: 'r1',
            webhooks: { reason: 'webhook-destination-blocked', address: '10.0.4.12' },
          },
        },
        400,
      ),
    );

    const error = await api
      .createWebhook(BRAND, { url: 'https://internal.example', events: ['ticket.created'] })
      .catch((caught: unknown) => caught);

    expect(isWebhooksError(error)).toBe(true);
    expect(error).toMatchObject({ reason: 'webhook-destination-blocked', address: '10.0.4.12' });
  });
});
