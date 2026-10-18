import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ConnectorContext } from '../connector.js';
import { collectAsync } from '../testing/collect.js';
import { fetchFreshdeskAttachment, freshdeskAttachmentRef } from './attachment-fetch.js';
import { FreshdeskClient } from './client.js';
import { type FreshdeskCredentials, freshdeskTicketSchema } from './contracts.js';
import { exportFreshdeskLegacyCsat } from './csat-export.js';
import { freshdeskValueMapping } from './mappings.js';
import {
  exportFreshdeskContacts,
  exportFreshdeskGroups,
  exportFreshdeskOrganizations,
  exportFreshdeskUsers,
} from './people-export.js';
import { exportFreshdeskTags } from './tags-export.js';
import { freshdeskTestContext } from './testing/context.js';
import { freshdeskCoreFixture } from './testing/core-fixture.js';
import { FakeFreshdesk } from './testing/fake-freshdesk.js';
import { exportFreshdeskThread } from './threads-export.js';
import { exportFreshdeskTickets } from './tickets-export.js';

let fake: FakeFreshdesk;
let client: FreshdeskClient;
let context: ConnectorContext<FreshdeskCredentials>;
beforeEach(async () => {
  fake = new FakeFreshdesk(freshdeskCoreFixture, {
    authorization: `Basic ${Buffer.from('synthetic-key:X').toString('base64')}`,
    now: Date.parse('2026-10-17T00:00:00Z'),
    pageSize: 2,
  });
  await fake.server.start();
  context = freshdeskTestContext(fake);
  client = new FreshdeskClient(context, fake.server.root);
});
afterEach(async () => {
  await fake.server.close();
});

it('uses Link pagination for full history, resumes a page and applies the documented delta filter', async () => {
  const query = {
    updated_since: '1970-01-01T00:00:00Z',
    order_by: 'updated_at',
    order_type: 'asc',
    per_page: '100',
    page: '1',
    include: 'description,stats',
  };
  const first = await client.page('/api/v2/tickets', freshdeskTicketSchema, query);
  expect(first.rows.map((row) => row.id)).toEqual([1, 2]);
  expect(first.nextPage).toBe(2);
  const resumed = await client.page('/api/v2/tickets', freshdeskTicketSchema, {
    ...query,
    page: String(first.nextPage),
  });
  expect(resumed.rows.map((row) => row.id)).toEqual([3]);
  expect(resumed.nextPage).toBeNull();
  const delta = await client.page('/api/v2/tickets', freshdeskTicketSchema, {
    ...query,
    updated_since: '2020-01-04T00:00:00Z',
  });
  expect(delta.rows.map((row) => row.id)).toEqual([3]);
  const recent = await client.page('/api/v2/tickets', freshdeskTicketSchema, { page: '1' });
  expect(recent.rows).toEqual([]);
});

it('normalizes original ownership, dates and custom data and resumes the saved ticket cursor', async () => {
  const iterator = exportFreshdeskTickets(client, null);
  const first = await iterator.next();
  expect(first.value?.records).toMatchObject([
    {
      entity: 'ticket',
      payload: {
        externalId: '1',
        number: '1',
        status: '2',
        priority: '1',
        channel: '1',
        requesterExternalId: '201',
        assigneeExternalId: '301',
        groupExternalId: '401',
        organizationExternalId: '501',
        custom: { cf_region: 'north' },
        ccEmails: ['cc@example.test'],
        tags: ['history'],
        createdAt: '2020-01-01T10:00:00Z',
        updatedAt: '2020-01-02T10:00:00Z',
      },
    },
    { payload: { externalId: '2' } },
  ]);
  await iterator.return(undefined);
  const resumed = await collectAsync(exportFreshdeskTickets(client, first.value?.cursor ?? null));
  expect(resumed.flatMap((page) => page.records.map((row) => row.payload.externalId))).toEqual([
    '3',
  ]);
  expect(resumed.at(-1)?.cursor).toBeNull();
});

it('preserves contact identities, company ownership and inactive source-agent attribution without granting roles', async () => {
  const contacts = await collectAsync(exportFreshdeskContacts(client, null));
  expect(contacts.flatMap((page) => page.records)).toMatchObject([
    {
      entity: 'contact',
      payload: {
        externalId: '201',
        name: 'Original customer',
        emails: ['customer@example.test', 'alternate@example.test'],
        phones: ['+15550000001', '+15550000002'],
        organizationExternalId: '501',
        locale: 'ar',
        timezone: 'Asia/Riyadh',
        externalRef: 'crm-201',
        custom: { cf_tier: 'gold' },
        description: 'Original customer details',
        createdAt: '2020-01-01T10:00:00Z',
        updatedAt: '2020-01-01T10:00:00Z',
      },
    },
  ]);
  const users = await collectAsync(exportFreshdeskUsers(client, null));
  expect(users.flatMap((page) => page.records)).toMatchObject([
    {
      entity: 'user',
      payload: {
        externalId: '301',
        kind: 'agent',
        name: 'Former agent',
        active: false,
        role: 'support_agent',
        groups: ['401'],
      },
    },
    { entity: 'user', payload: { externalId: '201', kind: 'customer', active: true } },
  ]);
  const companies = await collectAsync(exportFreshdeskOrganizations(client, null));
  expect(companies[0]?.records).toMatchObject([
    {
      entity: 'organization',
      payload: { externalId: '501', name: 'Source company', domains: ['example.test'] },
    },
  ]);
  const groups = await collectAsync(exportFreshdeskGroups(client, null));
  expect(groups[0]?.records).toEqual([
    { entity: 'group', payload: { externalId: '401', name: 'Billing' } },
  ]);
  expect(
    (
      await collectAsync(exportFreshdeskContacts(client, null, new Date('2026-01-01T00:00:00Z')))
    ).flatMap((page) => page.records),
  ).toEqual([]);
});

it('overlaps the final timestamp at the page ceiling instead of treating its missing Link as completion', async () => {
  fake.server.failNext({
    path: '/api/v2/tickets',
    status: 200,
    json: freshdeskCoreFixture.tickets?.slice(2),
  });
  const pages = await collectAsync(
    exportFreshdeskTickets(client, {
      page: 300,
      windowStart: '1970-01-01T00:00:00Z',
      lastUpdatedAt: '2020-01-03T10:00:00Z',
    }),
  );
  expect(pages[0]?.cursor).toEqual({ page: 1, windowStart: '2020-01-04T09:59:59.000Z' });
  expect(pages[1]?.records.map((row) => row.payload.externalId)).toEqual(['3']);
  expect(pages[1]?.cursor).toBeNull();
});

it('logs a completeness error and stops when timestamp ties prevent a safe next window', async () => {
  const log = vi.fn(async () => {});
  const loggingClient = new FreshdeskClient({ ...context, log }, fake.server.root);
  fake.server.failNext({
    path: '/api/v2/tickets',
    status: 200,
    json: freshdeskCoreFixture.tickets?.slice(2),
  });
  await expect(
    collectAsync(
      exportFreshdeskTickets(loggingClient, { page: 300, windowStart: '2020-01-04T09:59:59Z' }),
    ),
  ).rejects.toMatchObject({ code: 'invalid-response' });
  expect(log).toHaveBeenCalledWith({
    level: 'error',
    entity: 'ticket',
    message: 'import.freshdesk.timestamp-window-exhausted',
  });
});

it('makes the documented page ceiling an error instead of silently returning an empty final page', async () => {
  await expect(
    client.page('/api/v2/tickets', freshdeskTicketSchema, { page: '301' }),
  ).rejects.toMatchObject({ code: 'invalid-response', status: 400 });
});

it.each([
  'https://attacker.example/api/v2/tickets?page=2',
  '/api/v2/contacts?page=2',
  '/api/v2/tickets?page=1',
])('refuses a foreign or non-progressing next link: %s', async (next) => {
  fake.server.failNext({
    path: '/api/v2/tickets',
    status: 200,
    json: freshdeskCoreFixture.tickets,
    headers: { link: `<${next}>; rel="next"` },
  });
  await expect(
    client.page('/api/v2/tickets', freshdeskTicketSchema, { page: '1' }),
  ).rejects.toMatchObject({ code: 'invalid-response' });
});

it('exposes retry delay and vendor failure without reading or logging vendor bodies', async () => {
  fake.server.failNext({
    path: '/api/v2/tickets',
    status: 503,
    json: { secret: 'must-not-be-in-error' },
  });
  await expect(
    client.page('/api/v2/tickets', freshdeskTicketSchema, { page: '1' }),
  ).rejects.toMatchObject({ code: 'vendor-unavailable' });
  fake.server.failNext({ path: '/api/v2/tickets', status: 429, headers: { 'Retry-After': '34' } });
  await expect(
    client.page('/api/v2/tickets', freshdeskTicketSchema, { page: '1' }),
  ).rejects.toMatchObject({ retryAfterMs: 34000 });
});

it('refreshes expired attachment URLs through the ticket and never sends API credentials to the download', async () => {
  const attachment_url = fake.addAttachment(901, Buffer.from('historical media'));
  fake.replaceFixture({
    ...freshdeskCoreFixture,
    tickets: freshdeskCoreFixture.tickets?.map((row) => ({
      ...row,
      attachments: [
        { id: 901, name: 'history.txt', content_type: 'text/plain', size: 16, attachment_url },
      ],
    })),
  });
  const ticket = await client.json('/api/v2/tickets/1', freshdeskTicketSchema);
  const oldUrl = ticket.attachments[0]?.attachment_url;
  expect(oldUrl).toBeDefined();
  fake.expireDownloads();
  await expect(context.http.request(oldUrl ?? '')).rejects.toMatchObject({ status: 403 });
  const refreshed = await client.json('/api/v2/tickets/1', freshdeskTicketSchema);
  const response = await context.http.request(refreshed.attachments[0]?.attachment_url ?? '');
  expect(response.body.toString()).toBe('historical media');
  expect(fake.server.calls.at(-1)?.authenticated).toBe(false);
  await expect(client.json('https://attacker.example/secret', z.json())).rejects.toMatchObject({
    code: 'invalid-response',
  });
});

it('imports description and private notes with their real authors and resumes without replaying the description', async () => {
  const iterator = exportFreshdeskThread(client, { mode: 'message', cursor: null });
  const first = await iterator.next();
  expect(first.value?.records).toMatchObject([
    {
      entity: 'message',
      payload: {
        externalId: 'ticket:1:description',
        ticketExternalId: '1',
        authorExternalId: '201',
        authorKind: 'customer',
        public: true,
        bodyHtml: '<p>Original question</p>',
        createdAt: '2020-01-01T10:00:00Z',
      },
    },
  ]);
  await iterator.return(undefined);
  const resumed = await collectAsync(
    exportFreshdeskThread(client, { mode: 'message', cursor: first.value?.cursor ?? null }),
  );
  const records = resumed.flatMap((page) => page.records);
  expect(records).toHaveLength(3);
  expect(records[0]).toMatchObject({
    entity: 'message',
    payload: {
      externalId: '1001',
      ticketExternalId: '1',
      authorExternalId: '301',
      authorKind: 'agent',
      public: false,
      bodyHtml: '<p>Internal historical note</p>',
      createdAt: '2020-01-01T10:00:00Z',
    },
  });
  expect(records.map((record) => record.payload.externalId)).toEqual([
    '1001',
    'ticket:2:description',
    'ticket:3:description',
  ]);
  expect(resumed.at(-1)?.cursor).toBeNull();
});

it('refreshes a late conversation attachment in bounded requests using its source-page hint', async () => {
  const attachment_url = fake.addAttachment(902, Buffer.from('late history'));
  const attachment = {
    id: 902,
    name: 'late.txt',
    content_type: 'text/plain',
    size: 12,
    attachment_url,
  };
  fake.replaceFixture({
    ...freshdeskCoreFixture,
    conversations: {
      '1': Array.from({ length: 102 }, (_, index) => ({
        id: 1001 + index,
        ticket_id: 1,
        user_id: 301,
        incoming: false,
        private: true,
        body: `<p>Note ${index}</p>`,
        created_at: '2020-01-01T10:00:00Z',
        updated_at: '2020-01-01T10:00:00Z',
        attachments: index === 101 ? [attachment] : [],
      })),
    },
  });
  const ref = freshdeskAttachmentRef(1, 1102, attachment, 51);
  fake.expireDownloads();
  const downloaded = await fetchFreshdeskAttachment(context, client, ref);
  const chunks: Buffer[] = [];
  for await (const chunk of downloaded.stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe('late history');
  expect(
    fake.server.calls
      .filter((call) => call.path.endsWith('/conversations'))
      .map((call) => call.query.page),
  ).toEqual(['51']);
  expect(
    fake.server.calls
      .filter((call) => call.path.startsWith('/data/'))
      .every((call) => !call.authenticated),
  ).toBe(true);
});

it('extracts attachment records with stable parent references and refuses a missing hinted parent', async () => {
  const attachment_url = fake.addAttachment(902, Buffer.from('note media'));
  const attachment = {
    id: 902,
    name: 'note.txt',
    content_type: 'text/plain',
    size: 10,
    attachment_url,
  };
  const note = freshdeskCoreFixture.conversations?.['1']?.[0];
  if (!note) throw new Error('Missing conversation fixture');
  fake.replaceFixture({
    ...freshdeskCoreFixture,
    conversations: { '1': [{ ...note, attachments: [attachment] }] },
  });
  const pages = await collectAsync(
    exportFreshdeskThread(client, { mode: 'attachment', cursor: null }),
  );
  expect(pages.flatMap((page) => page.records)).toMatchObject([
    {
      entity: 'attachment',
      payload: {
        externalId: 't:1:m:1001:a:902',
        ticketExternalId: '1',
        messageExternalId: '1001',
        sourcePage: 1,
      },
    },
  ]);
  fake.expireDownloads();
  fake.replaceFixture({ ...freshdeskCoreFixture, conversations: { '1': [] } });
  await expect(
    fetchFreshdeskAttachment(context, client, freshdeskAttachmentRef(1, 1001, attachment, 1)),
  ).rejects.toMatchObject({ code: 'record-unavailable' });
});

it('keeps large tag pages bounded and resumes within a ticket-list page without losing tags', async () => {
  fake.replaceFixture({
    ...freshdeskCoreFixture,
    tickets: freshdeskCoreFixture.tickets?.map((ticket, index) => ({
      ...ticket,
      tags:
        index < 2
          ? Array.from(
              { length: 600 },
              (_, offset) => `tag-${String(index * 600 + offset).padStart(4, '0')}`,
            )
          : [],
    })),
  });
  const iterator = exportFreshdeskTags(client, null);
  const first = await iterator.next();
  expect(first.value?.records).toHaveLength(1000);
  await iterator.return(undefined);
  const remaining = await collectAsync(exportFreshdeskTags(client, first.value?.cursor ?? null));
  expect(remaining.every((page) => page.records.length <= 1000)).toBe(true);
  const ids = [...(first.value?.records ?? []), ...remaining.flatMap((page) => page.records)].map(
    (record) => record.payload.externalId,
  );
  expect(ids).toHaveLength(1200);
  expect(new Set(ids).size).toBe(1200);
  expect(ids.at(-1)).toBe('tag-1199');
});

it('preserves original satisfaction answers alongside acknowledged normalization and finds edits to old answers', async () => {
  const log = vi.fn(async () => {});
  const loggingClient = new FreshdeskClient({ ...context, log }, fake.server.root);
  const rating = {
    id: 801,
    ticket_id: 1,
    survey_id: 701,
    user_id: 201,
    agent_id: 301,
    group_id: 401,
    feedback: 'Original feedback',
    ratings: { default_question: 2, question_2: -103 },
    created_at: '2020-02-01T10:00:00Z',
    updated_at: '2020-02-02T10:00:00Z',
  };
  fake.replaceFixture({ ...freshdeskCoreFixture, satisfaction_ratings: [rating] });
  const full = await collectAsync(exportFreshdeskLegacyCsat(loggingClient, null));
  expect(full[0]?.records).toMatchObject([
    {
      entity: 'csat',
      payload: {
        externalId: 'legacy:801',
        ticketExternalId: '1',
        rating: 3,
        comment: 'Original feedback',
        ratedAt: '2020-02-01T10:00:00Z',
        sourceDetails: {
          originalRatings: { default_question: 2, question_2: -103 },
          responderExternalId: '201',
          agentExternalId: '301',
          groupExternalId: '401',
          ratingNormalization: 'sentiment-endpoints',
        },
      },
    },
  ]);
  expect(log).toHaveBeenCalledWith({
    level: 'warning',
    entity: 'csat',
    message: 'import.csat.scale-normalized',
  });
  fake.replaceFixture({
    ...freshdeskCoreFixture,
    satisfaction_ratings: [
      { ...rating, ratings: { default_question: 103 }, updated_at: '2026-10-17T00:00:00Z' },
    ],
  });
  const delta = await collectAsync(exportFreshdeskLegacyCsat(loggingClient, null));
  expect(delta[0]?.records).toMatchObject([
    { payload: { externalId: 'legacy:801', rating: 5, ratedAt: '2020-02-01T10:00:00Z' } },
  ]);
  expect(
    fake.server.calls
      .filter((call) => call.path.endsWith('/satisfaction_ratings'))
      .every((call) => !('created_since' in call.query)),
  ).toBe(true);
});

it('preserves a legacy survey with an unknown scale as an explicitly unscored answer', async () => {
  const log = vi.fn(async () => {});
  const loggingClient = new FreshdeskClient({ ...context, log }, fake.server.root);
  fake.replaceFixture({
    satisfaction_ratings: [
      {
        id: 801,
        ticket_id: 1,
        survey_id: 701,
        user_id: 201,
        ratings: { custom_question: 7 },
        feedback: 'Original custom survey answer',
        created_at: '2020-02-01T10:00:00Z',
        updated_at: '2020-02-02T10:00:00Z',
      },
    ],
  });
  const pages = await collectAsync(exportFreshdeskLegacyCsat(loggingClient, null));
  expect(pages.flatMap((page) => page.records)).toMatchObject([
    {
      entity: 'csat',
      payload: {
        rating: null,
        comment: 'Original custom survey answer',
        sourceDetails: {
          ratingUnmapped: true,
          originalRatings: { custom_question: 7 },
          originalAnswers: [
            { question_id: 'custom_question', question_text: 'custom_question', value: 7 },
          ],
        },
      },
    },
  ]);
  expect(log).toHaveBeenCalledWith({
    level: 'warning',
    entity: 'csat',
    message: 'import.csat.rating-unmapped',
  });
  expect(log).not.toHaveBeenCalledWith(
    expect.objectContaining({ message: 'import.csat.scale-normalized' }),
  );
});

it('proposes documented priority/channel meanings and leaves unknown values for explicit mapping', () => {
  expect(freshdeskValueMapping('priority', '2')).toEqual({
    kind: 'priority',
    externalValue: '2',
    target: { priority: 'medium' },
  });
  expect(freshdeskValueMapping('channel', '10')).toEqual({
    kind: 'channel',
    externalValue: '10',
    target: { channel: 'email' },
  });
  expect(freshdeskValueMapping('channel', '3')).toEqual({
    kind: 'channel',
    externalValue: '3',
    target: { channel: 'manual' },
  });
  expect(freshdeskValueMapping('priority', '99')).toBeNull();
  expect(freshdeskValueMapping('channel', '99')).toBeNull();
});
