import { afterEach, beforeEach, expect, it } from 'vitest';
import { ImportRateLimiter } from '../rate-limiter.js';
import { collectReference } from '../testing/reference-collection.js';
import type { TicketInventory } from '../ticket-inventory.js';
import { FreshdeskConnector } from './freshdesk.connector.js';
import { freshdeskTestContext } from './testing/context.js';
import { FakeFreshdesk } from './testing/fake-freshdesk.js';
import {
  freshdeskReferenceDelta,
  freshdeskReferenceFixture,
  freshdeskReferenceMedia,
} from './testing/reference-fixture.js';

let fake: FakeFreshdesk;
let fixture: ReturnType<typeof freshdeskReferenceFixture>;
let inventory: TicketInventory;
beforeEach(async () => {
  fake = new FakeFreshdesk(
    {},
    {
      authorization: `Basic ${Buffer.from('synthetic-key:X').toString('base64')}`,
      now: Date.now(),
    },
  );
  await fake.server.start();
  fixture = freshdeskReferenceFixture((id) => fake.addAttachment(id, freshdeskReferenceMedia));
  fake.replaceFixture(fixture);
  const ids = (fixture.tickets ?? [])
    .filter((ticket) => ticket.archived)
    .map((ticket) => String(ticket.id))
    .sort();
  inventory = {
    mode: 'archives',
    fingerprint: 'a'.repeat(64),
    next: async (after) => {
      const id = ids.find((id) => after === null || id > after);
      return id === undefined ? null : { externalId: id, location: 'archived' };
    },
  };
});
afterEach(async () => {
  await fake.server.close();
});

function connection() {
  const context = freshdeskTestContext(
    fake,
    async () => {},
    new ImportRateLimiter({ capacity: 100000, perMinute: 10000000 }),
  );
  return {
    connector: new FreshdeskConnector({ apiRoot: fake.server.root, inventory }),
    context: { ...context, credentials: { ...context.credentials, csatApi: 'legacy' as const } },
  };
}

it('extracts the complete 500-ticket reference graph across cursor restarts, refreshes media, and includes active/archive deltas', async () => {
  const full = await collectReference(connection);
  const tickets = full.filter((record) => record.entity === 'ticket');
  const contacts = full.filter((record) => record.entity === 'contact');
  const organizations = full.filter((record) => record.entity === 'organization');
  const messages = full.filter((record) => record.entity === 'message');
  const files = full.filter((record) => record.entity === 'attachment');
  const answers = full.filter((record) => record.entity === 'csat');
  expect(tickets).toHaveLength(500);
  expect(contacts).toHaveLength(50);
  expect(organizations).toHaveLength(10);
  expect(messages).toHaveLength(2000);
  expect(messages.filter((record) => !record.payload.public)).toHaveLength(500);
  expect(files).toHaveLength(500);
  expect(answers).toHaveLength(500);
  expect(full.filter((record) => record.entity === 'tag')).toHaveLength(6);
  const articles = full.filter((record) => record.entity === 'article');
  expect(articles).toHaveLength(40);
  expect(articles.filter((record) => record.payload.locale === 'en')).toHaveLength(20);
  expect(articles.filter((record) => record.payload.locale === 'ar')).toHaveLength(20);
  for (const source of fixture.tickets ?? []) {
    const ticket = tickets.find((record) => record.payload.externalId === String(source.id));
    expect(ticket?.payload).toMatchObject({
      number: String(source.id),
      subject: source.subject,
      status: String(source.status),
      priority: String(source.priority),
      channel: String(source.source),
      requesterExternalId: String(source.requester_id),
      assigneeExternalId: '301',
      groupExternalId: String(source.group_id),
      organizationExternalId: String(source.company_id),
      ccEmails: ['freshdesk-copy@example.invalid'],
      tags: source.tags,
      custom: source.custom_fields,
      createdAt: source.created_at,
      updatedAt: source.updated_at,
    });
    const thread = messages.filter(
      (record) => record.payload.ticketExternalId === String(source.id),
    );
    expect(thread).toHaveLength(4);
    expect(thread.filter((record) => record.payload.authorKind === 'agent')).toHaveLength(2);
    expect(
      thread.find((record) => record.payload.authorKind === 'customer')?.payload,
    ).toMatchObject({
      authorExternalId: String(source.requester_id),
      createdAt: source.created_at,
    });
  }
  fake.expireDownloads();
  const downloader = connection();
  for (const file of files) {
    const { ticketExternalId: _ticket, messageExternalId: _message, ...ref } = file.payload;
    const downloaded = await downloader.connector.fetchAttachment(downloader.context, ref);
    const chunks: Buffer[] = [];
    for await (const bytes of downloaded.stream) chunks.push(Buffer.from(bytes));
    expect(Buffer.concat(chunks)).toEqual(freshdeskReferenceMedia);
  }
  expect(
    fake.server.calls
      .filter((call) => call.path.startsWith('/data/helpdesk/attachments/'))
      .every((call) => !call.authenticated),
  ).toBe(true);
  const changedAt = new Date().toISOString();
  fake.replaceFixture(freshdeskReferenceDelta(fixture, changedAt));
  const delta = await collectReference(connection, new Date(Date.parse(changedAt) - 60000));
  for (const id of ['10000', '10499']) {
    expect(
      delta
        .filter((record) => record.entity === 'ticket')
        .find((record) => record.payload.externalId === id)?.payload,
    ).toMatchObject({ subject: `Delta subject ${id}`, status: '5' });
    expect(
      delta
        .filter((record) => record.entity === 'message')
        .find((record) => record.payload.bodyText === `Delta note ${id}`)?.payload,
    ).toMatchObject({ public: false, createdAt: changedAt });
  }
  const original = answers.find((record) => record.payload.ticketExternalId === '10000');
  expect(
    delta
      .filter((record) => record.entity === 'csat')
      .find((record) => record.payload.ticketExternalId === '10000')?.payload,
  ).toMatchObject({ comment: 'Corrected original feedback', ratedAt: original?.payload.ratedAt });
  expect(
    delta
      .filter((record) => record.entity === 'contact')
      .find((record) => record.payload.externalId === '20000')?.payload.description,
  ).toBe('Delta contact description');
  expect(fake.server.calls.every((call) => call.method === 'GET')).toBe(true);
}, 300000);
