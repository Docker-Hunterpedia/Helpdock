import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ZohoAccessToken } from './oauth.js';
import { zohoTestConnection } from './testing/context.js';
import { zohoCoreFixture } from './testing/core-fixture.js';
import { FakeZoho } from './testing/fake-zoho.js';

let fake: FakeZoho;
const now = () => Date.parse('2026-10-17T00:00:00Z');
beforeEach(async () => {
  fake = new FakeZoho(structuredClone(zohoCoreFixture));
  await fake.start();
});
afterEach(async () => {
  await fake.close();
});

it('reuses a saved token in a replacement connection without refreshing on each continuation', async () => {
  const snapshots: ZohoAccessToken[] = [];
  const first = zohoTestConnection(fake, {
    now,
    saveAccessToken: async (token) => {
      snapshots.push(structuredClone(token));
    },
  });
  await first.client.account();
  const saved = snapshots[0];
  if (!saved) throw new Error('Missing token snapshot');
  const resumed = zohoTestConnection(fake, { now, initialAccessToken: saved });
  expect(await resumed.client.account()).toBe(`us:${fake.fixture.orgId}`);
  expect(fake.calls.filter((call) => call.path === '/oauth/v2/token')).toHaveLength(1);
});

it('does not publish a newly refreshed token if its claim-protected save fails', async () => {
  let refused = true;
  const snapshots: ZohoAccessToken[] = [];
  const connection = zohoTestConnection(fake, {
    now,
    saveAccessToken: async (token) => {
      if (refused) throw new Error('synthetic-save-refused');
      snapshots.push(structuredClone(token));
    },
  });
  await expect(connection.client.account()).rejects.toThrow('synthetic-save-refused');
  expect(snapshots).toEqual([]);
  refused = false;
  await connection.client.account();
  expect(snapshots).toHaveLength(1);
  expect(fake.calls.filter((call) => call.path === '/oauth/v2/token')).toHaveLength(2);
});

it('replaces an expired saved snapshot and coalesces concurrent refreshes into one saved token', async () => {
  const snapshots: ZohoAccessToken[] = [];
  const connection = zohoTestConnection(fake, {
    now,
    initialAccessToken: { value: 'synthetic-expired', expiresAt: now() - 1 },
    saveAccessToken: async (token) => {
      snapshots.push(structuredClone(token));
    },
  });
  const accounts = await Promise.all(Array.from({ length: 4 }, () => connection.client.account()));
  expect(accounts).toEqual(Array(4).fill(`us:${fake.fixture.orgId}`));
  expect(snapshots).toHaveLength(1);
  expect(fake.calls.filter((call) => call.path === '/oauth/v2/token')).toHaveLength(1);
});

it.each([
  'synthetic\u2028token',
  'synthetic\u0100token',
  'synthetic\u0080token',
  'synthetic\r\ntoken',
])(
  'refuses a non-ASCII/control access token before sending any Desk authorization header',
  async (token) => {
    fake.failNext({
      path: '/oauth/v2/token',
      status: 200,
      json: {
        access_token: token,
        api_domain: 'https://desk.zoho.com',
        token_type: 'Bearer',
        expires_in: 3600,
      },
    });
    await expect(zohoTestConnection(fake).client.account()).rejects.toMatchObject({
      code: 'invalid-response',
    });
    expect(fake.calls.map((call) => call.path)).toEqual(['/oauth/v2/token']);
  },
);
