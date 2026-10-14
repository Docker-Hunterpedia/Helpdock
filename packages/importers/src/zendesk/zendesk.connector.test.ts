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
  expect(captured.message?.flatMap((page) => page.records)).toMatchObject([
    {
      payload: {
        externalId: '901',
        authorKind: 'customer',
        public: true,
        createdAt: '2020-01-01T10:00:00Z',
        attachments: [{ externalId: '1101', fileName: 'receipt.pdf' }],
      },
    },
    {
      payload: {
        externalId: '902',
        authorKind: 'agent',
        public: false,
        createdAt: '2020-01-02T10:00:00Z',
      },
    },
  ]);
  expect(captured.attachment?.flatMap((page) => page.records)).toMatchObject([
    {
      payload: {
        externalId: '1101',
        ticketExternalId: '101',
        messageExternalId: '901',
        fileName: 'receipt.pdf',
        size: 100,
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

it('traverses all comment pages including empty attachment-only bodies and retains a thread delta watermark', async () => {
  const original = zendeskCoreFixture.comments?.['101']?.[0];
  if (!original) throw new Error('Missing source comment fixture');
  fake.replaceFixture({
    ...zendeskCoreFixture,
    comments: {
      '101': Array.from({ length: 101 }, (_, index) => ({
        ...original,
        id: 901 + index,
        html_body: null,
        body: '',
        plain_body: '',
        public: index % 2 === 0,
      })),
    },
  });
  const pages = await collectPages(connector.extract(context, 'message', null));
  const records = pages.flatMap((page) => page.records);
  expect(records).toHaveLength(101);
  expect(records[100]).toMatchObject({
    entity: 'message',
    payload: { externalId: '1001', bodyText: '', attachments: [{ externalId: '1101' }] },
  });
  expect(pages.at(-1)).toMatchObject({
    cursor: null,
    deltaCursor: { mode: 'message', tickets: { after: expect.any(String) } },
  });
  expect(fake.server.calls.filter((call) => call.path === '/api/v2/users/201.json')).toHaveLength(
    1,
  );
});

it('resumes a thread after its committed reply and refuses changed history before skipping that reply', async () => {
  const iterator = connector.extract(context, 'message', null)[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || !first.value.cursor) throw new Error('Missing thread checkpoint');
  await iterator.return?.(undefined);
  const resumed = await collectPages(connector.extract(context, 'message', first.value.cursor));
  expect(
    resumed.flatMap((page) => page.records.map((record) => record.payload.externalId)),
  ).toEqual(['902']);
  const comments = (zendeskCoreFixture.comments?.['101'] ?? []).map((comment) =>
    comment.id === 901 ? { ...comment, html_body: '<p>Redacted</p>' } : comment,
  );
  fake.replaceFixture({ ...zendeskCoreFixture, comments: { '101': comments } });
  await expect(
    collectPages(connector.extract(context, 'message', first.value.cursor)),
  ).rejects.toMatchObject({ code: 'invalid-response' });
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

it('exports every field page with separate source scopes and stable keys matching ticket and profile values', async () => {
  const fields = Array.from({ length: 101 }, (_, index) => ({
    id: 1000 + index,
    title: `Field ${index}`,
    type: 'text',
  }));
  fake.replaceFixture({ ...zendeskCoreFixture, ticket_fields: fields });
  const pages = await collectPages(connector.extract(context, 'field', null));
  const records = pages.flatMap((page) => page.records);
  expect(records).toHaveLength(103);
  expect(records[100]).toEqual({
    entity: 'field',
    payload: {
      externalId: 'ticket:1100',
      target: 'ticket',
      key: '1100',
      label: 'Field 100',
      type: 'text',
    },
  });
  expect(records[101]).toMatchObject({
    payload: { externalId: 'contact:801', key: 'plan', target: 'contact' },
  });
  expect(records[102]).toMatchObject({
    payload: { externalId: 'organization:801', key: 'region', target: 'organization' },
  });
  const first = pages[0];
  if (!first?.cursor) throw new Error('Missing field checkpoint');
  const resumed = await collectPages(connector.extract(context, 'field', first.cursor));
  expect(resumed.flatMap((page) => page.records)).toEqual(records.slice(100));
});

it('refuses unsupported relationship fields instead of silently converting references into text', async () => {
  const warnings: Parameters<typeof context.log>[0][] = [];
  context.log = async (entry) => {
    warnings.push(entry);
  };
  fake.replaceFixture({
    ...zendeskCoreFixture,
    user_fields: [{ id: 900, key: 'manager', title: 'Manager', type: 'lookup' }],
  });
  await expect(collectPages(connector.extract(context, 'field', null))).rejects.toMatchObject({
    code: 'invalid-response',
  });
  expect(warnings).toMatchObject([
    { level: 'warning', entity: 'field', externalId: 'contact:900' },
  ]);
});

it('discovers historical tags from tickets instead of the limited popular-tag endpoint', async () => {
  const original = zendeskCoreFixture.tickets?.[0];
  if (!original) throw new Error('Missing source ticket');
  fake.replaceFixture({
    ...zendeskCoreFixture,
    tickets: [{ ...original, tags: ['old-2019', 'old-2019', 'migration'] }],
  });
  const pages = await collectPages(connector.extract(context, 'tag', null));
  expect(pages.flatMap((page) => page.records)).toEqual([
    { entity: 'tag', payload: { externalId: 'old-2019', name: 'old-2019' } },
    { entity: 'tag', payload: { externalId: 'migration', name: 'migration' } },
  ]);
  expect(pages.at(-1)).toMatchObject({ cursor: null, deltaCursor: { after: expect.any(String) } });
  expect(fake.server.calls.some((call) => call.path === '/api/v2/tags.json')).toBe(false);
});

it('retains source changes and historical notifications as inert activity without duplicating comments', async () => {
  const pages = await collectPages(connector.extract(context, 'activity', null));
  expect(pages.flatMap((page) => page.records)).toMatchObject([
    {
      entity: 'activity',
      payload: {
        externalId: '1201:1202',
        ticketExternalId: '101',
        authorExternalId: '301',
        authorKind: 'agent',
        action: 'zendesk.Change',
        from: { field: 'status', value: 'open' },
        to: { field: 'status', value: 'pending' },
        createdAt: '2020-01-02T10:00:00Z',
        details: { metadata: { custom: { time_spent: '3m22s' } } },
      },
    },
    {
      entity: 'activity',
      payload: {
        externalId: '1201:1203',
        action: 'zendesk.Notification',
        details: { event: { body: 'Original notification' } },
      },
    },
  ]);
  expect(fake.server.calls.every((call) => call.method === 'GET')).toBe(true);
});

it('resumes audit history across all pages and refuses changes to a committed audit page', async () => {
  const original = zendeskCoreFixture.audits?.['101']?.[0];
  if (!original) throw new Error('Missing source audit');
  const audits = Array.from({ length: 101 }, (_, index) => ({ ...original, id: 2000 + index }));
  fake.replaceFixture({ ...zendeskCoreFixture, audits: { '101': audits } });
  const iterator = connector.extract(context, 'activity', null)[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || !first.value.cursor) throw new Error('Missing audit checkpoint');
  await iterator.return?.(undefined);
  const resumed = await collectPages(connector.extract(context, 'activity', first.value.cursor));
  expect(resumed.flatMap((page) => page.records)).toHaveLength(200);
  expect(resumed.at(-1)).toMatchObject({
    cursor: null,
    deltaCursor: { mode: 'activity', tickets: { after: expect.any(String) } },
  });
  fake.replaceFixture({
    ...zendeskCoreFixture,
    audits: {
      '101': audits.map((audit, index) =>
        index === 0 ? { ...audit, metadata: { custom: { redacted: true } } } : audit,
      ),
    },
  });
  await expect(
    collectPages(connector.extract(context, 'activity', first.value.cursor)),
  ).rejects.toMatchObject({ code: 'invalid-response' });
});

it('accepts an unpaginated archived audit response exceeding one hundred rows without truncation', async () => {
  const original = zendeskCoreFixture.audits?.['101']?.[0];
  if (!original) throw new Error('Missing source audit');
  fake.server.failNext({
    path: '/api/v2/tickets/101/audits.json',
    status: 200,
    json: {
      audits: Array.from({ length: 101 }, (_, index) => ({
        ...original,
        id: 2000 + index,
        author_id: null,
      })),
      next_page: null,
    },
  });
  const pages = await collectPages(connector.extract(context, 'activity', null));
  expect(pages.flatMap((page) => page.records)).toHaveLength(202);
  expect(pages[0]?.records[0]).toMatchObject({ payload: { authorKind: 'system' } });
});

it('uses the terminal ticket watermark to revisit changed audit history on delta', async () => {
  const full = await collectPages(connector.extract(context, 'activity', null));
  const watermark = full.at(-1)?.deltaCursor;
  const ticket = zendeskCoreFixture.tickets?.[0];
  const audit = zendeskCoreFixture.audits?.['101']?.[0];
  if (!watermark || !ticket || !audit) throw new Error('Missing source delta fixture');
  fake.advanceTime(120);
  fake.replaceFixture({
    ...zendeskCoreFixture,
    tickets: [{ ...ticket, updated_at: '2026-10-14T00:00:10Z' }],
    audits: {
      '101': [
        {
          ...audit,
          events: [
            {
              id: 1301,
              type: 'Change',
              field_name: 'assignee_id',
              previous_value: null,
              value: 301,
            },
          ],
          created_at: '2026-10-14T00:00:10Z',
        },
      ],
    },
  });
  const delta = await collectPages(connector.extract(context, 'activity', watermark));
  expect(delta.flatMap((page) => page.records)).toMatchObject([
    {
      payload: {
        externalId: '1201:1301',
        from: { field: 'assignee_id', value: null },
        to: { field: 'assignee_id', value: 301 },
        createdAt: '2026-10-14T00:00:10Z',
      },
    },
  ]);
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
