import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import type { ConnectorContext } from '../connector.js';
import { ImportHttp } from '../http.js';
import { ImportRateLimiter } from '../rate-limiter.js';
import { ZohoDeskClient } from './client.js';
import { ZohoOAuthSession } from './oauth.js';
import { ZOHO_REGIONS, type ZohoCredentials } from './regions.js';
import { FakeZoho } from './testing/fake-zoho.js';

const credentials: ZohoCredentials = {
  region: 'us',
  orgId: '9007199254740993123',
  clientId: 'synthetic-client',
  clientSecret: 'synthetic-client-secret',
  refreshToken: 'synthetic-refresh',
};
let fake: FakeZoho;
beforeEach(async () => {
  fake = new FakeZoho({
    ...credentials,
    organizations: [{ id: credentials.orgId, companyName: 'Synthetic support' }],
  });
  await fake.start();
});
afterEach(async () => {
  await fake.close();
});

function connection(input: ZohoCredentials = credentials, now?: () => number) {
  const context: ConnectorContext<ZohoCredentials> = {
    credentials: input,
    signal: new AbortController().signal,
    log: async () => {},
    http: new ImportHttp({
      dailyCreditLimit: true,
      hosts: ['127.0.0.1'],
      limiter: new ImportRateLimiter({ capacity: 100, perMinute: 1000 }),
      policy: {
        allowedPorts: [Number(new URL(fake.root).port)],
        allowCidrs: ['127.0.0.1/32'],
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      },
    }),
  };
  const oauth = new ZohoOAuthSession(input, context.http, {
    signal: context.signal,
    accountsRoot: fake.root,
    ...(now ? { now } : {}),
  });
  return { client: new ZohoDeskClient(context, oauth, fake.root), oauth };
}

it.each(Object.keys(ZOHO_REGIONS) as (keyof typeof ZOHO_REGIONS)[])(
  'binds the %s token domain and string organization ID without putting secrets in URLs',
  async (region) => {
    fake.tokenDomain = ZOHO_REGIONS[region].desk;
    const { client } = connection({ ...credentials, region });
    expect(await client.account()).toBe(`${region}:${credentials.orgId}`);
    expect(fake.calls).toEqual([
      {
        method: 'POST',
        path: '/oauth/v2/token',
        query: {},
        authenticated: false,
        orgId: undefined,
      },
      {
        method: 'GET',
        path: '/api/v1/organizations',
        query: {},
        authenticated: true,
        orgId: credentials.orgId,
      },
    ]);
  },
);

it('coalesces concurrent refreshes and reuses a token until its expiry margin', async () => {
  let now = Date.parse('2026-10-17T00:00:00Z');
  const { client } = connection(credentials, () => now);
  expect(await Promise.all(Array.from({ length: 5 }, () => client.account()))).toEqual(
    Array(5).fill(`us:${credentials.orgId}`),
  );
  now += 3_500_000;
  await client.account();
  expect(fake.calls.filter((call) => call.path === '/oauth/v2/token')).toHaveLength(1);
  now += 80_000;
  await client.account();
  expect(fake.calls.filter((call) => call.path === '/oauth/v2/token')).toHaveLength(2);
});

it('refreshes an expired access token once and never retries permission denials as expiry', async () => {
  const { client } = connection();
  await client.account();
  fake.expireToken();
  expect(await client.account()).toBe(`us:${credentials.orgId}`);
  expect(fake.calls.filter((call) => call.path === '/oauth/v2/token')).toHaveLength(2);
  fake.failNext({
    path: '/api/v1/organizations',
    status: 403,
    json: { errorCode: 'OAUTH_SCOPE_MISMATCH' },
  });
  await expect(client.account()).rejects.toMatchObject({
    code: 'credentials-refused',
    status: 403,
  });
  expect(fake.calls.filter((call) => call.path === '/oauth/v2/token')).toHaveLength(2);
});

it('stops after one token retry when the refreshed token is also refused', async () => {
  const { client } = connection();
  for (let attempt = 0; attempt < 2; attempt++)
    fake.failNext({ path: '/api/v1/organizations', status: 401 });
  await expect(client.account()).rejects.toMatchObject({
    code: 'credentials-refused',
    status: 401,
  });
  expect(fake.calls.filter((call) => call.path === '/oauth/v2/token')).toHaveLength(2);
});

it.each([
  'https://desk.zoho.eu',
  'https://api.zoho.com',
  'https://www.zohoapis.com',
  'https://attacker.example',
  'https://desk.zoho.com/path',
  'https://desk.zoho.com?token=secret',
  'https://user:secret@desk.zoho.com',
  'http://desk.zoho.com',
])('refuses token api_domain %s before any Desk read', async (domain) => {
  fake.tokenDomain = domain;
  const { client } = connection();
  await expect(client.account()).rejects.toMatchObject({ code: 'invalid-response' });
  expect(fake.calls.filter((call) => call.path.startsWith('/api/'))).toEqual([]);
});

it('refuses an unbound organization and redacts an OAuth refusal body', async () => {
  const { client } = connection();
  fake.fixture.organizations.splice(0);
  await expect(client.account()).rejects.toMatchObject({ code: 'credentials-refused' });
  const wrong = connection({ ...credentials, clientSecret: 'different-synthetic-secret' });
  await expect(wrong.client.account()).rejects.toThrow('credentials-refused');
});

it('never follows a token redirect, including a same-origin redirect that could replay its form', async () => {
  fake.failNext({
    path: '/oauth/v2/token',
    status: 307,
    headers: { location: `${fake.root}/secret-collector` },
  });
  const { client } = connection();
  await expect(client.account()).rejects.toMatchObject({ code: 'too-many-redirects' });
  expect(fake.calls.map((call) => call.path)).toEqual(['/oauth/v2/token']);
});

it('refuses authenticated API redirects instead of accepting replacement JSON from an asset host', async () => {
  fake.failNext({
    path: '/api/v1/organizations',
    status: 302,
    headers: { location: `${fake.root}/replacement-organizations` },
  });
  const { client } = connection();
  await expect(client.account()).rejects.toMatchObject({ code: 'too-many-redirects' });
  expect(fake.calls.map((call) => call.path)).toEqual(['/oauth/v2/token', '/api/v1/organizations']);
});

it.each([
  'https://attacker.example/api/v1/tickets',
  '//attacker.example/api/v1/tickets',
  '/oauth/v2/token',
])('refuses an unsafe resource path %s before refreshing credentials', async (path) => {
  const { client } = connection();
  await expect(client.json(path, z.object({}))).rejects.toMatchObject({ code: 'invalid-response' });
  expect(fake.calls).toEqual([]);
});

it('preserves rate limiting and retries a transient token-service failure on the next attempt', async () => {
  const { client } = connection();
  fake.failNext({ path: '/oauth/v2/token', status: 503 });
  await expect(client.account()).rejects.toMatchObject({ code: 'vendor-unavailable' });
  expect(await client.account()).toBe(`us:${credentials.orgId}`);
  fake.failNext({ path: '/api/v1/organizations', status: 429, headers: { 'Retry-After': '17' } });
  await expect(client.account()).rejects.toMatchObject({ retryAfterMs: 17000 });
});

it('accepts documented HTTP 204 only as an empty list, never as a fabricated detail', async () => {
  const { client } = connection();
  fake.failNext({ path: '/api/v1/articles', status: 204 });
  await expect(
    client.list('/api/v1/articles', z.object({ data: z.array(z.object({ id: z.string() })) })),
  ).resolves.toEqual({ data: [] });
  fake.failNext({ path: '/api/v1/articles/7001', status: 204 });
  await expect(
    client.json('/api/v1/articles/7001', z.object({ id: z.string() })),
  ).rejects.toMatchObject({ code: 'invalid-response' });
  fake.failNext({ path: '/api/v1/articles', status: 200, bytes: Buffer.alloc(0) });
  await expect(
    client.list('/api/v1/articles', z.object({ data: z.array(z.object({ id: z.string() })) })),
  ).rejects.toMatchObject({ code: 'invalid-response' });
});

it('defers daily credit exhaustion for the documented reset instead of probing each second', async () => {
  const { client } = connection();
  fake.failNext({
    path: '/api/v1/organizations',
    status: 429,
    json: { errorCode: 'THRESHOLD_EXCEEDED', message: 'Daily credit limit exceeded' },
  });
  await expect(client.request('/api/v1/organizations')).rejects.toMatchObject({
    retryAfterMs: 86400000,
  });
});
