import { describe, expect, it } from 'vitest';
import { isWebhooksError } from './api.js';
import { MockDevelopersApi } from './mock-api.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';

const reasonOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  return isWebhooksError(error) ? error.reason : undefined;
};

describe('MockDevelopersApi', () => {
  it('starts every brand with the artboards’ keys and endpoints', async () => {
    const api = new MockDevelopersApi();

    const { keys } = await api.apiKeys(BRAND);
    const { webhooks } = await api.webhooks(BRAND);

    expect(keys.map((key) => key.name)).toContain('Zapier sync');
    expect(keys.filter((key) => key.revokedAt !== null)).toHaveLength(1);
    expect(webhooks.map((webhook) => [webhook.enabled, webhook.disabledReason])).toEqual([
      [true, null],
      [true, null],
      [true, null],
      [false, 'failures'],
    ]);
  });

  it('issues a key once and revokes it for good', async () => {
    const api = new MockDevelopersApi();

    const created = await api.createApiKey(BRAND, { name: 'CI', scopes: ['tickets:read'] });
    const revoked = await api.revokeApiKey(BRAND, created.id);

    expect(created.key.startsWith(created.prefix)).toBe(true);
    expect(created.rateLimitPerMinute).toBe(600);
    expect(revoked.revokedAt).not.toBeNull();
    expect(JSON.stringify(await api.apiKeys(BRAND))).not.toContain(created.key);
  });

  it('refuses plain http and private names as the api does', async () => {
    const api = new MockDevelopersApi();
    const add = (url: string) => api.createWebhook(BRAND, { url, events: ['ticket.created'] });

    expect(await reasonOf(add('http://hooks.example.com'))).toBe('webhook-https-required');
    expect(await reasonOf(add('https://billing.internal.example.com'))).toBe(
      'webhook-destination-blocked',
    );
    expect(await reasonOf(add('https://localhost/hooks'))).toBe('webhook-destination-blocked');
    expect((await add('https://hooks.example.com')).secret).toMatch(/^whsec_[0-9a-f]{43}$/);
  });

  it('draws each secret from the platform generator, so no two are alike', async () => {
    const api = new MockDevelopersApi();
    const [first] = (await api.webhooks(BRAND)).webhooks;
    if (first === undefined) {
      throw new Error('expected a seeded webhook');
    }

    const rotated = await api.rotateWebhookSecret(BRAND, first.id);
    const again = await api.rotateWebhookSecret(BRAND, first.id);
    expect(rotated.secret).not.toBe(again.secret);
  });

  it('answers a test ping pending once, then delivered', async () => {
    const api = new MockDevelopersApi();
    const [first] = (await api.webhooks(BRAND)).webhooks;
    if (first === undefined) {
      throw new Error('the fixture has endpoints');
    }

    const ping = await api.sendTestEvent(BRAND, first.id);

    expect(ping.status).toBe('pending');
    expect((await api.delivery(BRAND, first.id, ping.id)).status).toBe('pending');
    const settled = await api.delivery(BRAND, first.id, ping.id);
    expect(settled).toMatchObject({ status: 'succeeded', responseStatus: 200 });
    expect(settled.request.headers.map((header) => header.name)).toContain('x-helpdock-signature');
  });
});
