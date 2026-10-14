import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ConnectorContext, ImportPage } from '../connector.js';
import { ImportHttp } from '../http.js';
import { ImportRateLimiter } from '../rate-limiter.js';
import type { ZendeskCredentials } from './contracts.js';
import { zendeskCoreFixture } from './testing/core-fixture.js';
import { FakeZendesk } from './testing/fake-zendesk.js';
import { ZendeskConnector } from './zendesk.connector.js';

async function collectPages(source: AsyncIterable<ImportPage>): Promise<ImportPage[]> {
  const pages: ImportPage[] = [];
  for await (const page of source) pages.push(page);
  return pages;
}

const NOW = Date.parse('2026-10-14T00:00:00Z') / 1000;
let fake: FakeZendesk;
let connector: ZendeskConnector;
let context: ConnectorContext<ZendeskCredentials>;
beforeEach(async () => {
  fake = new FakeZendesk(zendeskCoreFixture, { authorization: 'Bearer synthetic-token', now: NOW });
  await fake.server.start();
  connector = new ZendeskConnector({ apiRoot: fake.server.root });
  context = {
    credentials: { auth: 'oauth', subdomain: 'demo', accessToken: 'synthetic-token' },
    http: new ImportHttp({
      hosts: ['127.0.0.1', 'cdn.zendesk.test'],
      limiter: new ImportRateLimiter({ capacity: 100, perMinute: 1000 }),
      policy: {
        allowedPorts: [Number(new URL(fake.server.root).port)],
        allowCidrs: ['127.0.0.1/32'],
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      },
    }),
    signal: new AbortController().signal,
    log: async () => {},
  };
});
afterEach(async () => {
  await fake.server.close();
});

it('converts core export data without granting source roles or dropping CC references and company descriptions', async () => {
  expect(await connector.test(context)).toEqual({ ok: true, account: 'demo' });
  const captured: Record<string, ImportPage[]> = {};
  for (const entity of connector.entities) {
    captured[entity] = [];
    for await (const page of connector.extract(context, entity, null)) captured[entity]?.push(page);
  }
  expect(captured.ticket?.[0]?.records).toMatchObject([
    {
      entity: 'ticket',
      payload: {
        externalId: '101',
        status: 'pending:701',
        priority: 'normal',
        channel: 'email',
        ccExternalIds: ['202'],
        custom: { '801': 'north' },
        createdAt: '2020-01-01T10:00:00Z',
        updatedAt: '2020-01-02T10:00:00Z',
      },
    },
  ]);
  expect(captured.user?.[0]?.records).toMatchObject([
    { payload: { externalId: '201', kind: 'customer', active: true } },
    { payload: { externalId: '202', kind: 'customer', active: true } },
    { payload: { externalId: '301', kind: 'agent', role: 'admin', active: false } },
  ]);
  expect(captured.organization?.[0]?.records).toMatchObject([
    {
      payload: {
        externalId: '401',
        domains: ['example.invalid', 'other.invalid'],
        notes: 'Account note',
        description: 'Original description',
        createdAt: '2019-01-01T00:00:00Z',
        updatedAt: '2020-01-02T10:00:00Z',
        custom: { region: 'north' },
      },
    },
  ]);
  expect(captured.group?.[0]?.records).toEqual([
    { entity: 'group', payload: { externalId: '501', name: 'Original support team' } },
  ]);
  expect(captured.contact?.[0]?.records).toMatchObject([
    {
      payload: {
        externalId: '201',
        emails: ['customer@example.invalid', 'secondary@example.invalid'],
        phones: ['+15551234567'],
        sourceIdentities: [
          { externalId: '601', verificationMethod: 'full' },
          { externalId: '602' },
          { externalId: '603', type: 'twitter', value: 'original-handle' },
        ],
      },
    },
  ]);
  expect(connector.defaultMappings(captured.ticket?.[0]?.records ?? [])).toEqual([
    { kind: 'priority', externalValue: 'normal', target: { priority: 'medium' } },
    { kind: 'channel', externalValue: 'email', target: { channel: 'email' } },
  ]);
  expect(fake.server.calls.every((call) => call.method === 'GET')).toBe(true);
});

it('traverses ticket cursor pages and continues from the final vendor watermark for delta', async () => {
  const original = zendeskCoreFixture.tickets?.[0];
  if (!original) throw new Error('Missing core ticket fixture');
  fake.replaceFixture({
    ...zendeskCoreFixture,
    tickets: Array.from({ length: 1001 }, (_, index) => ({ ...original, id: index + 1 })),
  });
  const pages: ImportPage[] = [];
  for await (const page of connector.extract(context, 'ticket', null)) pages.push(page);
  expect(pages.map((page) => page.records.length)).toEqual([1000, 1]);
  expect(pages[0]?.cursor).not.toBeNull();
  const final = pages[1];
  if (!final?.deltaCursor) throw new Error('Missing final vendor watermark');
  fake.advanceTime(120);
  fake.replaceFixture({
    ...zendeskCoreFixture,
    tickets: [{ ...original, updated_at: '2026-10-14T00:00:10Z' }],
  });
  const delta: ImportPage[] = [];
  for await (const page of connector.extract(context, 'ticket', final.deltaCursor))
    delta.push(page);
  expect(delta).toMatchObject([
    {
      cursor: null,
      records: [{ payload: { externalId: '101', updatedAt: '2026-10-14T00:00:10Z' } }],
    },
  ]);
});

it('resumes a contact checkpoint without repeating hydrated contacts and refuses changed source pages', async () => {
  const iterator = connector.extract(context, 'contact', null)[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || !first.value.cursor) throw new Error('Missing first contact checkpoint');
  await iterator.return?.(undefined);
  fake.server.calls.length = 0;
  const resumed = await collectPages(connector.extract(context, 'contact', first.value.cursor));
  expect(
    resumed.flatMap((page) => page.records.map((record) => record.payload.externalId)),
  ).toEqual(['202', '301']);
  expect(fake.server.calls.some((call) => call.path === '/api/v2/users/201/identities.json')).toBe(
    false,
  );
  const changedUsers = (zendeskCoreFixture.users ?? []).map((user) =>
    user.id === 201 ? { ...user, name: 'Changed while paused' } : user,
  );
  fake.replaceFixture({ ...zendeskCoreFixture, users: changedUsers });
  await expect(
    collectPages(connector.extract(context, 'contact', first.value.cursor)),
  ).rejects.toMatchObject({ code: 'invalid-response' });
});

it('rejects untrusted pagination origins before sending source credentials to another host', async () => {
  fake.server.failNext({
    path: '/api/v2/groups.json',
    status: 200,
    json: { groups: [], next_page: 'http://cdn.zendesk.test/api/v2/groups.json?page=2' },
  });
  await expect(collectPages(connector.extract(context, 'group', null))).rejects.toMatchObject({
    code: 'invalid-response',
  });
  expect(fake.server.calls).toHaveLength(1);
});

it('downloads stable Support attachment URLs without credentials reaching the redirected CDN', async () => {
  const url = fake.addAttachment('receipt', Buffer.from('original attachment'));
  const downloaded = await connector.fetchAttachment(context, {
    externalId: 'receipt',
    fileName: 'receipt.pdf',
    url,
  });
  const chunks: Buffer[] = [];
  for await (const chunk of downloaded.stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe('original attachment');
  expect(
    fake.server.calls
      .filter((call) => call.path.startsWith('/cdn/'))
      .every((call) => !call.authenticated),
  ).toBe(true);
});

it('propagates rate limits and transient errors instead of yielding successful empty exports', async () => {
  fake.server.failNext({ path: '/api/v2/groups.json', status: 503 });
  await expect(collectPages(connector.extract(context, 'group', null))).rejects.toMatchObject({
    code: 'vendor-unavailable',
  });
  fake.server.failNext({
    path: '/api/v2/groups.json',
    status: 429,
    headers: { 'retry-after': '34' },
  });
  await expect(collectPages(connector.extract(context, 'group', null))).rejects.toMatchObject({
    retryAfterMs: 34000,
  });
});
