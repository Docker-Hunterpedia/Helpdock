import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import type { ConnectorContext, ImportPage } from '../connector.js';
import { ImportHttp } from '../http.js';
import { ImportRateLimiter } from '../rate-limiter.js';
import type { ZendeskCredentials } from './contracts.js';
import { zendeskCoreFixture } from './testing/core-fixture.js';
import { FakeZendesk, type ZendeskFixture } from './testing/fake-zendesk.js';
import { ZendeskConnector } from './zendesk.connector.js';

async function collectPages(source: AsyncIterable<ImportPage>): Promise<ImportPage[]> {
  const pages: ImportPage[] = [];
  for await (const page of source) pages.push(page);
  return pages;
}

const NOW = Date.parse('2026-10-14T00:00:00Z') / 1000;

it.each(['user', 'contact'] as const)(
  'exports %s pages that cross the API JSON boundary without coercion',
  async (entity) => {
    for await (const page of connector.extract(context, entity, null)) {
      expect(() => z.json().parse(page)).not.toThrow();
    }
  },
);
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

it('imports only answered legacy CSAT with original score, reason, actors and explicit date provenance', async () => {
  fake.replaceFixture({ ...zendeskCoreFixture, survey_responses: [] });
  const warnings: Parameters<typeof context.log>[0][] = [];
  context.log = async (entry) => {
    warnings.push(entry);
  };
  const pages = await collectPages(connector.extract(context, 'csat', null));
  expect(pages.flatMap((page) => page.records)).toMatchObject([
    {
      entity: 'csat',
      payload: {
        externalId: 'legacy:1401',
        rating: 5,
        ratedAt: '2020-01-03T10:00:00Z',
        sourceDetails: {
          score: 'good',
          updatedAt: '2020-01-04T10:00:00Z',
          ratedAtBasis: 'source-created-at',
          assigneeExternalId: '301',
        },
      },
    },
    {
      entity: 'csat',
      payload: {
        externalId: 'legacy:1402',
        rating: 1,
        comment: 'Original negative feedback',
        sourceDetails: { reason: 'Took too long', scale: ['bad', 'good'] },
      },
    },
  ]);
  expect(warnings).toMatchObject([{ level: 'warning', entity: 'csat' }]);
});

it('resumes all CSAT pages and rescans old ratings on delta to retain later corrections', async () => {
  const original = zendeskCoreFixture.satisfaction_ratings?.[0];
  if (!original) throw new Error('Missing source rating');
  fake.replaceFixture({
    ...zendeskCoreFixture,
    survey_responses: [],
    satisfaction_ratings: Array.from({ length: 101 }, (_, index) => ({
      ...original,
      id: 2000 + index,
    })),
  });
  const iterator = connector.extract(context, 'csat', null)[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || !first.value.cursor) throw new Error('Missing rating checkpoint');
  await iterator.return?.(undefined);
  const resumed = await collectPages(connector.extract(context, 'csat', first.value.cursor));
  expect(resumed.flatMap((page) => page.records)).toMatchObject([
    { payload: { externalId: 'legacy:2100' } },
  ]);
  fake.replaceFixture({
    ...zendeskCoreFixture,
    survey_responses: [],
    satisfaction_ratings: [
      { ...original, comment: 'Corrected old feedback', updated_at: '2026-10-14T00:00:00Z' },
    ],
  });
  const delta = await collectPages(
    connector.extract(context, 'csat', null, new Date('2026-10-13T00:00:00Z')),
  );
  expect(delta.flatMap((page) => page.records)).toMatchObject([
    {
      payload: {
        externalId: 'legacy:1401',
        comment: 'Corrected old feedback',
        sourceDetails: { updatedAt: '2026-10-14T00:00:00Z' },
      },
    },
  ]);
  expect(
    fake.server.calls
      .filter((call) => call.path === '/api/v2/satisfaction_ratings.json')
      .every((call) => !Object.hasOwn(call.query, 'start_time')),
  ).toBe(true);
});

it('extracts modern survey answers with original rating, full answer provenance and native answer dates', async () => {
  const pages = await collectPages(connector.extract(context, 'csat', null));
  const records = pages
    .flatMap((page) => page.records)
    .filter((record) => record.payload.externalId.startsWith('survey:'));
  expect(records).toMatchObject([
    {
      entity: 'csat',
      payload: {
        externalId: 'survey:survey-1501:rating-question',
        ticketExternalId: '101',
        rating: 5,
        comment: 'Original survey feedback',
        ratedAt: '2024-08-14T12:00:00Z',
        sourceDetails: {
          originalRating: 4,
          ratingNormalization: 'category-endpoints',
          ratingCategory: 'good',
          ratedAtBasis: 'answer-created-at',
          answers: [
            { type: 'rating_scale', rating: 4 },
            { type: 'open_ended', value: 'Original survey feedback' },
          ],
        },
      },
    },
  ]);
});

it('resumes modern survey cursors without restarting the completed legacy phase', async () => {
  const original = zendeskCoreFixture.survey_responses?.[0];
  if (!original) throw new Error('Missing source survey');
  fake.replaceFixture({
    ...zendeskCoreFixture,
    satisfaction_ratings: [],
    survey_responses: Array.from({ length: 101 }, (_, index) => ({
      ...original,
      id: `survey-${index}`,
    })),
  });
  const iterator = connector.extract(context, 'csat', null)[Symbol.asyncIterator]();
  await iterator.next();
  const firstSurveyPage = await iterator.next();
  if (firstSurveyPage.done || !firstSurveyPage.value.cursor)
    throw new Error('Missing survey checkpoint');
  await iterator.return?.(undefined);
  fake.server.calls.length = 0;
  const resumed = await collectPages(
    connector.extract(context, 'csat', firstSurveyPage.value.cursor),
  );
  expect(resumed.flatMap((page) => page.records)).toMatchObject([
    { payload: { externalId: 'survey:survey-100:rating-question' } },
  ]);
  expect(fake.server.calls.every((call) => call.path === '/api/v2/guide/survey_responses')).toBe(
    true,
  );
});

it('refuses ambiguous ticket associations instead of attributing a survey answer to the wrong ticket', async () => {
  const original = zendeskCoreFixture.survey_responses?.[0];
  if (!original) throw new Error('Missing source survey');
  fake.replaceFixture({
    ...zendeskCoreFixture,
    satisfaction_ratings: [],
    survey_responses: [
      {
        ...original,
        subjects: [
          { id: '101', type: 'ticket', zrn: 'zen:ticket:101' },
          { id: '102', type: 'ticket', zrn: 'zen:ticket:102' },
        ],
      },
    ],
  });
  await expect(collectPages(connector.extract(context, 'csat', null))).rejects.toMatchObject({
    code: 'invalid-response',
  });
});

it('preserves bilingual Guide taxonomy and each translation draft state without treating editorial permissions as readership', async () => {
  const categories = await collectPages(connector.extract(context, 'category', null));
  const sections = await collectPages(connector.extract(context, 'section', null));
  const articles = await collectPages(connector.extract(context, 'article', null));
  expect(categories.flatMap((page) => page.records)).toEqual([
    {
      entity: 'category',
      payload: {
        externalId: 'category:1601',
        names: { en: 'Documentation', ar: 'التوثيق' },
        descriptions: { en: 'Original category', ar: 'وصف التصنيف' },
      },
    },
  ]);
  expect(sections.flatMap((page) => page.records)).toMatchObject([
    {
      payload: {
        externalId: 'section:1602',
        parentExternalId: 'category:1601',
        names: { en: 'Getting started', ar: 'البدء' },
      },
    },
  ]);
  expect(articles.flatMap((page) => page.records)).toMatchObject([
    {
      payload: {
        externalId: 'article:1603',
        locale: 'en',
        draft: false,
        internal: false,
        bodyHtml: '<p>Original English content</p>',
        createdAt: '2020-01-01T00:00:00Z',
      },
    },
    {
      payload: {
        externalId: 'article:1603:ar',
        locale: 'ar',
        draft: true,
        internal: false,
        bodyHtml: '<p>المحتوى العربي الأصلي</p>',
        translationOf: 'article:1603',
        createdAt: '2020-01-02T00:00:00Z',
      },
    },
  ]);
});

it.each(['restricted', 'unknown'] as const)(
  'keeps %s Guide readership internal and persists a warning instead of publishing it',
  async (readership) => {
    const original = zendeskCoreFixture.articles?.[0];
    if (!original) throw new Error('Missing source article');
    const article = { ...original };
    if (readership === 'unknown') delete article.user_segment_id;
    else article.user_segment_id = 800;
    fake.replaceFixture({ ...zendeskCoreFixture, articles: [article] });
    const warnings: Parameters<typeof context.log>[0][] = [];
    context.log = async (entry) => {
      warnings.push(entry);
    };
    const pages = await collectPages(connector.extract(context, 'article', null));
    expect(pages.flatMap((page) => page.records)).toHaveLength(2);
    expect(
      pages
        .flatMap((page) => page.records)
        .every((record) => record.entity === 'article' && record.payload.internal),
    ).toBe(true);
    expect(warnings).toEqual([
      {
        level: 'warning',
        entity: 'article',
        externalId: 'article:1603',
        message: 'import.knowledge.readership-restricted',
      },
    ]);
  },
);

it('resumes a committed Guide article without repeating translations and refuses a changed source page', async () => {
  const iterator = connector.extract(context, 'article', null)[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || !first.value.cursor) throw new Error('Missing Guide checkpoint');
  await iterator.return?.(undefined);
  const resumed = await collectPages(connector.extract(context, 'article', first.value.cursor));
  expect(resumed.flatMap((page) => page.records)).toEqual([]);
  const original = zendeskCoreFixture.articles?.[0];
  if (!original) throw new Error('Missing source article');
  fake.replaceFixture({
    ...zendeskCoreFixture,
    articles: [{ ...original, updated_at: '2026-10-14T00:00:00Z' }],
  });
  await expect(
    collectPages(connector.extract(context, 'article', first.value.cursor)),
  ).rejects.toMatchObject({ code: 'invalid-response' });
});

it('extracts nested Guide section parents separately from their owning category', async () => {
  const original = zendeskCoreFixture.sections?.[0];
  if (!original) throw new Error('Missing source section');
  fake.replaceFixture({
    ...zendeskCoreFixture,
    sections: [{ ...original, parent_section_id: 1801 }],
  });
  const pages = await collectPages(connector.extract(context, 'section', null));
  expect(pages.flatMap((page) => page.records)).toMatchObject([
    {
      payload: {
        externalId: 'section:1602',
        parentExternalId: 'category:1601',
        parentSectionExternalId: 'section:1801',
        names: { en: 'Getting started', ar: 'البدء' },
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

it('refreshes an expired CDN URL by numeric attachment ID without leaking account credentials', async () => {
  const stable = fake.addAttachment('498483', Buffer.from('refreshed history'));
  const initial = await context.http.request(stable, {
    headers: { authorization: 'Bearer synthetic-token' },
  });
  fake.expireDownloads();
  const result = await connector.fetchAttachment(context, {
    externalId: '498483',
    fileName: 'receipt.pdf',
    url: initial.url,
  });
  const chunks: Buffer[] = [];
  for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe('refreshed history');
  expect(
    fake.server.calls.filter((call) => call.path === '/api/v2/attachments/498483'),
  ).toHaveLength(1);
  expect(
    fake.server.calls
      .filter((call) => call.path.startsWith('/cdn/'))
      .every((call) => !call.authenticated),
  ).toBe(true);
});

it('does not turn account authorization failure into a refresh loop', async () => {
  const stable = fake.addAttachment('498485', Buffer.from('denied history'));
  fake.server.failNext({ path: '/attachments/token/498485/file', status: 403 });
  await expect(
    connector.fetchAttachment(context, {
      externalId: '498485',
      fileName: 'receipt.pdf',
      url: stable,
    }),
  ).rejects.toMatchObject({ code: 'credentials-refused' });
  expect(fake.server.calls.some((call) => call.path.startsWith('/api/v2/attachments/'))).toBe(
    false,
  );
});

it('bounds refresh to one lookup when an attachment is deleted or its replacement remains unavailable', async () => {
  const stable = fake.addAttachment('498486', Buffer.from('missing history'));
  fake.server.failNext({ path: '/attachments/token/498486/file', status: 404 });
  fake.server.failNext({ path: '/attachments/token/498486/file', status: 410 });
  await expect(
    connector.fetchAttachment(context, {
      externalId: '498486',
      fileName: 'receipt.pdf',
      url: stable,
    }),
  ).rejects.toMatchObject({ code: 'record-unavailable' });
  expect(
    fake.server.calls.filter((call) => call.path === '/api/v2/attachments/498486'),
  ).toHaveLength(1);
  await expect(
    connector.fetchAttachment(context, {
      externalId: '999999',
      fileName: 'deleted.pdf',
      url: `${fake.server.root}/missing-file`,
    }),
  ).rejects.toMatchObject({ code: 'record-unavailable' });
});

it('rejects attachment metadata for another native ID', async () => {
  fake.server.failNext({
    path: '/api/v2/attachments/498487',
    status: 200,
    json: {
      attachment: { id: 1, file_name: 'wrong.pdf', content_url: `${fake.server.root}/wrong` },
    },
  });
  await expect(
    connector.fetchAttachment(context, {
      externalId: '498487',
      fileName: 'receipt.pdf',
      url: `${fake.server.root}/missing-file`,
    }),
  ).rejects.toMatchObject({ code: 'invalid-response' });
});

it('chunks a timestamp-tied organization response above one thousand without losing resume or delta state', async () => {
  const original = zendeskCoreFixture.organizations?.[0];
  if (!original) throw new Error('Missing organization fixture');
  fake.replaceFixture({
    ...zendeskCoreFixture,
    organizations: Array.from({ length: 1001 }, (_, index) => ({ ...original, id: index + 1 })),
  });
  const stream = connector.extract(context, 'organization', null)[Symbol.asyncIterator]();
  const first = await stream.next();
  if (first.done || !first.value.cursor) throw new Error('Missing organization chunk');
  expect(first.value.records).toHaveLength(1000);
  await stream.return?.(undefined);
  const resumed = await collectPages(
    connector.extract(context, 'organization', first.value.cursor),
  );
  expect(
    resumed.flatMap((page) => page.records.map((record) => record.payload.externalId)),
  ).toEqual(['1001']);
  const watermark = resumed.at(-1)?.deltaCursor;
  if (!watermark) throw new Error('Missing organization delta watermark');
  expect(watermark).toEqual({ startTime: Date.parse('2026-10-13T23:59:00Z') / 1000 });
  fake.advanceTime(120);
  fake.replaceFixture({
    ...zendeskCoreFixture,
    organizations: [
      {
        ...original,
        id: 1001,
        notes: 'Changed after full export',
        updated_at: '2026-10-14T00:00:10Z',
      },
    ],
  });
  const delta = await collectPages(connector.extract(context, 'organization', watermark));
  expect(delta.flatMap((page) => page.records)).toMatchObject([
    { payload: { externalId: '1001', notes: 'Changed after full export' } },
  ]);
});

it('refuses a changed organization page rather than skipping rows under an old chunk checkpoint', async () => {
  const original = zendeskCoreFixture.organizations?.[0];
  if (!original) throw new Error('Missing organization fixture');
  const organizations: NonNullable<ZendeskFixture['organizations']> = Array.from(
    { length: 1001 },
    (_, index) => ({
      ...original,
      id: index + 1,
    }),
  );
  fake.replaceFixture({ ...zendeskCoreFixture, organizations });
  const stream = connector.extract(context, 'organization', null)[Symbol.asyncIterator]();
  const first = await stream.next();
  if (first.done || !first.value.cursor) throw new Error('Missing organization checkpoint');
  await stream.return?.(undefined);
  organizations[0] = { ...original, id: 1, name: 'Changed page' };
  fake.replaceFixture({ ...zendeskCoreFixture, organizations });
  await expect(
    collectPages(connector.extract(context, 'organization', first.value.cursor)),
  ).rejects.toMatchObject({ code: 'invalid-response' });
});
