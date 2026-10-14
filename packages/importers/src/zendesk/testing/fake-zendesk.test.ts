import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { ImportHttp } from '../../http.js';
import { ImportRateLimiter } from '../../rate-limiter.js';
import { FakeZendesk, type ZendeskFixture } from './fake-zendesk.js';

const NOW = Date.parse('2026-10-14T00:00:00Z') / 1000;
const AUTH = 'Bearer synthetic-zendesk-token';
const row = z.looseObject({ id: z.number() });
const cursorPage = z.object({
  tickets: z.array(row),
  after_cursor: z.string(),
  after_url: z.url(),
  end_of_stream: z.boolean(),
});
const fixture: ZendeskFixture = {
  tickets: [
    {
      id: 101,
      subject: 'Original question',
      status: 'pending',
      updated_at: '2020-01-01T00:00:00Z',
    },
    { id: 102, subject: 'Archived ticket', status: 'closed', updated_at: '2020-01-02T00:00:00Z' },
    { id: 103, status: 'deleted', updated_at: '2020-01-03T00:00:00Z' },
  ],
  users: [{ id: 201, role: 'end-user', updated_at: '2020-01-01T00:00:00Z' }],
  organizations: [
    { id: 401, name: 'First', updated_at: '2020-01-01T00:00:00Z' },
    { id: 402, name: 'Same timestamp', updated_at: '2020-01-01T00:00:00Z' },
    { id: 403, name: 'Later', updated_at: '2020-01-02T00:00:00Z' },
  ],
  comments: {
    '101': [
      {
        id: 901,
        author_id: 201,
        public: true,
        html_body: '<p>Question</p>',
        created_at: '2020-01-01T00:00:00Z',
        attachments: [],
      },
      {
        id: 902,
        author_id: 301,
        public: false,
        html_body: '<p>Private note</p>',
        created_at: '2020-01-02T00:00:00Z',
        attachments: [],
      },
    ],
  },
  audits: {
    '101': [
      {
        id: 1001,
        ticket_id: 101,
        author_id: 301,
        created_at: '2020-01-02T00:00:00Z',
        events: [
          {
            id: 1201,
            type: 'Change',
            field_name: 'status',
            previous_value: 'open',
            value: 'pending',
          },
        ],
      },
    ],
  },
  articles: [
    {
      id: 1401,
      section_id: 1501,
      locale: 'en-us',
      draft: false,
      permission_group_id: 1601,
      user_segment_ids: [1701],
      updated_at: '2020-01-01T00:00:00Z',
    },
  ],
  translations: {
    '1401': [
      { id: 1801, source_id: 1401, locale: 'en-us', title: 'Delivery', draft: false },
      { id: 1802, source_id: 1401, locale: 'ar', title: 'تتبّع الطلب', draft: true },
    ],
  },
  user_segments: [{ id: 1701, user_type: 'signed_in_users', organization_ids: [401] }],
};

let fake: FakeZendesk;
let http: ImportHttp;
beforeEach(async () => {
  fake = new FakeZendesk(fixture, { authorization: AUTH, now: NOW, pageSize: 1 });
  await fake.server.start();
  http = new ImportHttp({
    hosts: ['127.0.0.1', 'cdn.zendesk.test'],
    limiter: new ImportRateLimiter({ capacity: 100, perMinute: 1000 }),
    policy: {
      allowedPorts: [Number(new URL(fake.server.root).port)],
      allowCidrs: ['127.0.0.1/32'],
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    },
  });
});
afterEach(async () => {
  await fake.server.close();
});
const auth = { headers: { authorization: AUTH } };

it('exports all ticket pages including archived records and tombstones, then resumes its final cursor for delta', async () => {
  let next = `${fake.server.root}/api/v2/incremental/tickets/cursor.json?start_time=0&per_page=1&support_type_scope=all`;
  const ids: number[] = [];
  for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
    const page = await http.json(next, cursorPage, auth);
    ids.push(...page.tickets.map((ticket) => ticket.id));
    expect(page.end_of_stream).toBe(pageNumber === 2);
    next = page.after_url;
  }
  expect(ids).toEqual([101, 102, 103]);
  fake.advanceTime(120);
  fake.replaceFixture({
    ...fixture,
    tickets: [
      { id: 101, subject: 'Changed question', updated_at: '2026-10-14T00:00:10Z' },
      ...(fixture.tickets ?? []).slice(1),
    ],
  });
  const delta = await http.json(next, cursorPage, auth);
  expect(delta.tickets).toEqual([
    { id: 101, subject: 'Changed question', updated_at: '2026-10-14T00:00:10Z' },
  ]);
  expect(delta.end_of_stream).toBe(true);
  const userExport = await http.json(
    `${fake.server.root}/api/v2/incremental/users/cursor.json?start_time=0`,
    z.object({ users: z.array(row), after_cursor: z.string() }),
    auth,
  );
  expect(userExport.users).toMatchObject([{ id: 201, role: 'end-user' }]);
});

it('advances time exports through tied organization dates without dropping a company or looping', async () => {
  const schema = z.object({
    organizations: z.array(row),
    end_time: z.number(),
    next_page: z.url(),
    end_of_stream: z.boolean(),
  });
  const first = await http.json(
    `${fake.server.root}/api/v2/incremental/organizations.json?start_time=0&per_page=1`,
    schema,
    auth,
  );
  expect(first.organizations.map((company) => company.id)).toEqual([401, 402]);
  expect(first.end_of_stream).toBe(false);
  const second = await http.json(first.next_page, schema, auth);
  expect(second.organizations.map((company) => company.id)).toEqual([403]);
  expect(second.end_of_stream).toBe(true);
});

it('returns paged comments, per-ticket audits and separate Guide translations and read segments', async () => {
  const schema = z.object({
    comments: z.array(row),
    meta: z.object({ has_more: z.boolean(), after_cursor: z.string() }),
    links: z.object({ next: z.url().nullable() }),
  });
  const first = await http.json(
    `${fake.server.root}/api/v2/tickets/101/comments.json?page[size]=1`,
    schema,
    auth,
  );
  expect(first.comments).toMatchObject([{ id: 901, public: true }]);
  if (!first.links.next) throw new Error('Expected second source comment page');
  const second = await http.json(first.links.next, schema, auth);
  expect(second.comments).toMatchObject([{ id: 902, public: false, author_id: 301 }]);
  expect(second.meta.has_more).toBe(false);
  expect(
    await http.json(
      `${fake.server.root}/api/v2/tickets/101/audits.json`,
      z.object({ audits: z.array(row) }),
      auth,
    ),
  ).toMatchObject({ audits: [{ id: 1001, events: [{ type: 'Change', field_name: 'status' }] }] });
  const firstTranslation = await http.json(
    `${fake.server.root}/api/v2/help_center/articles/1401/translations.json`,
    z.object({ translations: z.array(row), next_page: z.url().nullable() }),
    auth,
  );
  if (!firstTranslation.next_page) throw new Error('Expected Arabic translation page');
  expect(
    await http.json(firstTranslation.next_page, z.object({ translations: z.array(row) }), auth),
  ).toMatchObject({ translations: [{ locale: 'ar', draft: true, title: 'تتبّع الطلب' }] });
  expect(
    await http.json(
      `${fake.server.root}/api/v2/help_center/user_segments.json`,
      z.object({ user_segments: z.array(row) }),
      auth,
    ),
  ).toMatchObject({ user_segments: [{ user_type: 'signed_in_users', organization_ids: [401] }] });
});

it('rejects wrong credentials and malformed or cross-resource cursors rather than returning empty history', async () => {
  await expect(http.request(`${fake.server.root}/api/v2/users/me.json`)).rejects.toMatchObject({
    code: 'credentials-refused',
  });
  const page = await http.json(
    `${fake.server.root}/api/v2/incremental/tickets/cursor.json?start_time=0&support_type_scope=all`,
    cursorPage,
    auth,
  );
  await expect(
    http.request(
      `${fake.server.root}/api/v2/incremental/users/cursor.json?cursor=${page.after_cursor}`,
      auth,
    ),
  ).rejects.toMatchObject({ code: 'invalid-response' });
  await expect(
    http.request(
      `${fake.server.root}/api/v2/incremental/tickets/cursor.json?start_time=${NOW}`,
      auth,
    ),
  ).rejects.toMatchObject({ code: 'invalid-response' });
  await expect(
    http.request(`${fake.server.root}/api/v2/tickets/101/comments.json?page[after]=unknown`, auth),
  ).rejects.toMatchObject({ code: 'invalid-response' });
  await expect(
    http.request(`${fake.server.root}/api/v2/tickets/101/comments.json`, {
      ...auth,
      method: 'POST',
    }),
  ).rejects.toMatchObject({ status: 405 });
});

it('returns vendor throttling and transient errors without hiding them behind successful empty pages', async () => {
  const path = '/api/v2/groups.json';
  fake.server.failNext({ path, status: 503, json: { error: 'Temporarily unavailable' } });
  await expect(http.request(`${fake.server.root}${path}`, auth)).rejects.toMatchObject({
    code: 'vendor-unavailable',
  });
  expect(
    await http.json(`${fake.server.root}${path}`, z.object({ groups: z.array(row) }), auth),
  ).toEqual({ groups: [] });
  fake.server.failNext({
    path,
    status: 429,
    headers: { 'retry-after': '34' },
    json: { error: 'Rate limit exceeded' },
  });
  await expect(http.request(`${fake.server.root}${path}`, auth)).rejects.toMatchObject({
    retryAfterMs: 34000,
  });
});

it('resolves authenticated attachment redirects without credentials on the CDN and refreshes expired downloads', async () => {
  const original = fake.addAttachment('receipt', Buffer.from('historical attachment'));
  const downloaded = await http.request(original, auth);
  expect(downloaded.body.toString()).toBe('historical attachment');
  expect(
    fake.server.calls
      .filter((call) => call.path.startsWith('/cdn/'))
      .every((call) => !call.authenticated),
  ).toBe(true);
  fake.expireDownloads();
  await expect(http.request(downloaded.url)).rejects.toMatchObject({
    code: 'credentials-refused',
    status: 403,
  });
  expect((await http.request(original, auth)).body.toString()).toBe('historical attachment');
});
