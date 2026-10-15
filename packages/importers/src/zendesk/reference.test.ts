import type { ImportEntity, ImportRecord } from '@helpdock/schemas';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ConnectorContext, ImportCursor } from '../connector.js';
import { ImportHttp } from '../http.js';
import { ImportRateLimiter } from '../rate-limiter.js';
import type { ZendeskCredentials } from './contracts.js';
import { FakeZendesk } from './testing/fake-zendesk.js';
import { zendeskReferenceFixture, zendeskReferenceMedia } from './testing/reference-fixture.js';
import { ZendeskConnector } from './zendesk.connector.js';

const fake = new FakeZendesk(
  {},
  { authorization: 'Bearer synthetic-reference', now: Date.parse('2026-10-15T00:00:00Z') / 1000 },
);
let connector: ZendeskConnector;
let context: ConnectorContext<ZendeskCredentials>;
beforeAll(async () => {
  await fake.server.start();
  connector = new ZendeskConnector({ apiRoot: fake.server.root });
  context = {
    credentials: { auth: 'oauth', subdomain: 'demo', accessToken: 'synthetic-reference' },
    http: new ImportHttp({
      hosts: ['127.0.0.1', 'cdn.zendesk.test'],
      limiter: new ImportRateLimiter({ capacity: 100000, perMinute: 10000000 }),
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
afterAll(async () => {
  await fake.server.close();
});

it('extracts the 500-ticket reference graph and revisits only changed ticket history while rescanning mutable CSAT', async () => {
  const fixture = zendeskReferenceFixture(fake.server.root);
  for (const ticket of fixture.tickets ?? [])
    fake.addAttachment(String(ticket.id * 100 + 3), zendeskReferenceMedia, {
      fileName: `reference-${ticket.id}.pdf`,
      contentType: 'application/pdf',
    });
  fake.replaceFixture(fixture);
  const captured = new Map<ImportEntity, Map<string, ImportRecord>>();
  const watermarks = new Map<ImportEntity, ImportCursor>();
  for (const entity of connector.entities) {
    const records = new Map<string, ImportRecord>();
    for await (const page of connector.extract(context, entity, null)) {
      expect(page.records.length).toBeLessThanOrEqual(1000);
      for (const record of page.records) {
        expect(record.entity).toBe(entity);
        records.set(record.payload.externalId, record);
      }
      if (page.deltaCursor) watermarks.set(entity, page.deltaCursor);
    }
    captured.set(entity, records);
  }
  for (const [entity, count] of Object.entries({
    ticket: 500,
    user: 503,
    contact: 503,
    organization: 10,
    group: 5,
    message: 1000,
    attachment: 500,
    activity: 500,
    csat: 500,
    field: 3,
    tag: 6,
    category: 1,
    section: 1,
    article: 2,
  }))
    expect(captured.get(entity as ImportEntity)?.size, entity).toBe(count);
  for (const source of fixture.tickets ?? []) {
    expect(captured.get('ticket')?.get(String(source.id))).toMatchObject({
      entity: 'ticket',
      payload: {
        subject: source.subject,
        requesterExternalId: String(source.requester_id),
        assigneeExternalId: '301',
        organizationExternalId: String(source.organization_id),
        groupExternalId: String(source.group_id),
        priority: source.priority,
        channel: 'email',
        status: source.status === 'closed' ? 'closed' : 'pending:701',
        tags: source.tags,
        custom: { '801': 'north' },
        ccExternalIds: ['202'],
        createdAt: source.created_at,
        updatedAt: source.updated_at,
      },
    });
    expect(captured.get('message')?.get(String(source.id * 100 + 1))).toMatchObject({
      payload: {
        public: true,
        authorKind: 'customer',
        authorExternalId: String(source.requester_id),
        createdAt: source.created_at,
        attachments: [{ externalId: String(source.id * 100 + 3) }],
      },
    });
    expect(captured.get('message')?.get(String(source.id * 100 + 2))).toMatchObject({
      payload: { public: false, authorKind: 'agent', authorExternalId: '301', attachments: [] },
    });
    expect(
      captured.get('activity')?.get(`${source.id * 1000}:${source.id * 1000 + 1}`),
    ).toMatchObject({
      payload: {
        ticketExternalId: String(source.id),
        action: 'zendesk.Change',
        createdAt: source.updated_at,
      },
    });
    expect(captured.get('csat')?.get(`legacy:${source.id * 10}`)).toMatchObject({
      payload: {
        ticketExternalId: String(source.id),
        ratedAt: source.updated_at,
        sourceDetails: { score: 'good', ratedAtBasis: 'source-created-at' },
      },
    });
  }
  for (let index = 0; index < 500; index++)
    expect(captured.get('contact')?.get(String(20001 + index))).toMatchObject({
      payload: {
        name: `Customer ${index}`,
        emails: [`customer-${index}@example.invalid`, `secondary-${20001 + index}@example.invalid`],
        notes: `Original contact note ${index}`,
        description: `Original contact description ${index}`,
        timezone: 'Asia/Damascus',
        custom: { plan: `plan-${index}` },
      },
    });
  expect(
    [...(captured.get('article')?.values() ?? [])]
      .map((record) => (record.entity === 'article' ? record.payload.locale : null))
      .sort(),
  ).toEqual(['ar', 'en']);
  for (const ticketId of [101, 350, 600]) {
    const ref = captured.get('attachment')?.get(String(ticketId * 100 + 3));
    if (ref?.entity !== 'attachment') throw new Error('Missing reference media');
    const { ticketExternalId: _ticket, messageExternalId: _message, ...attachment } = ref.payload;
    const downloaded = await connector.fetchAttachment(context, attachment);
    const chunks: Buffer[] = [];
    for await (const chunk of downloaded.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(zendeskReferenceMedia);
  }
  const updatedAt = '2026-10-15T00:00:10Z';
  fake.advanceTime(120);
  fake.replaceFixture({
    ...fixture,
    tickets: fixture.tickets?.map((ticket) =>
      ticket.id === 101
        ? {
            ...ticket,
            subject: 'Delta subject',
            status: 'solved',
            custom_status_id: null,
            updated_at: updatedAt,
          }
        : ticket,
    ),
    users: fixture.users?.map((user) =>
      user.id === 20001 ? { ...user, notes: 'Delta contact note', updated_at: updatedAt } : user,
    ),
    organizations: fixture.organizations?.map((company) =>
      company.id === 401
        ? { ...company, notes: 'Delta company note', updated_at: updatedAt }
        : company,
    ),
    comments: {
      ...fixture.comments,
      '101': [
        ...(fixture.comments?.['101'] ?? []),
        {
          id: 10104,
          author_id: 301,
          public: false,
          body: 'Delta internal note',
          created_at: updatedAt,
          attachments: [],
        },
      ],
    },
    audits: {
      ...fixture.audits,
      '101': [
        ...(fixture.audits?.['101'] ?? []),
        {
          id: 999999,
          ticket_id: 101,
          author_id: 301,
          created_at: updatedAt,
          events: [
            {
              id: 999998,
              type: 'Change',
              field_name: 'status',
              previous_value: 'pending',
              value: 'solved',
            },
          ],
        },
      ],
    },
    satisfaction_ratings: fixture.satisfaction_ratings?.map((rating) =>
      rating.ticket_id === 101
        ? { ...rating, comment: 'Corrected old feedback', updated_at: updatedAt }
        : rating,
    ),
  });
  const delta = new Map<ImportEntity, ImportRecord[]>();
  for (const entity of [
    'ticket',
    'message',
    'attachment',
    'activity',
    'contact',
    'organization',
    'csat',
  ] as const) {
    const records: ImportRecord[] = [];
    for await (const page of connector.extract(context, entity, watermarks.get(entity) ?? null))
      records.push(...page.records);
    delta.set(entity, records);
  }
  for (const [entity, count] of Object.entries({
    ticket: 1,
    message: 3,
    attachment: 1,
    activity: 2,
    contact: 1,
    organization: 1,
    csat: 500,
  }))
    expect(delta.get(entity as ImportEntity)).toHaveLength(count);
  expect(delta.get('ticket')).toMatchObject([
    { payload: { externalId: '101', subject: 'Delta subject', status: 'solved' } },
  ]);
  expect(delta.get('message')?.at(-1)).toMatchObject({
    payload: {
      externalId: '10104',
      bodyText: 'Delta internal note',
      public: false,
      createdAt: updatedAt,
    },
  });
  expect(delta.get('contact')).toMatchObject([
    { payload: { externalId: '20001', notes: 'Delta contact note' } },
  ]);
  expect(delta.get('organization')).toMatchObject([
    { payload: { externalId: '401', notes: 'Delta company note' } },
  ]);
  expect(
    delta.get('csat')?.find((record) => record.payload.externalId === 'legacy:1010'),
  ).toMatchObject({
    payload: { comment: 'Corrected old feedback', ratedAt: '2018-01-03T10:00:00.000Z' },
  });
  expect(fake.server.calls.every((call) => call.method === 'GET')).toBe(true);
}, 60000);
