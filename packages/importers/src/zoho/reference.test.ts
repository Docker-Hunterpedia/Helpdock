import { afterEach, beforeEach, expect, it } from 'vitest';
import { collectReference } from '../testing/reference-collection.js';
import { zohoTestConnection } from './testing/context.js';
import { zohoCoreFixture } from './testing/core-fixture.js';
import { FakeZoho } from './testing/fake-zoho.js';
import {
  zohoReferenceDelta,
  zohoReferenceFixture,
  zohoReferenceMedia,
} from './testing/reference-fixture.js';
import { ZohoConnector } from './zoho.connector.js';

let fake: FakeZoho;
let fixture: ReturnType<typeof zohoReferenceFixture>;
beforeEach(async () => {
  fake = new FakeZoho(structuredClone(zohoCoreFixture));
  await fake.start();
  fixture = zohoReferenceFixture({
    ticket: (locator) => fake.addAttachment({ ...locator, kind: 'threads' }, zohoReferenceMedia),
    article: (locator) => fake.addArticleAttachment(locator, zohoReferenceMedia),
  });
  Object.assign(fake.fixture, fixture);
});
afterEach(async () => {
  await fake.close();
});

function connection() {
  return {
    connector: new ZohoConnector({ apiRoot: fake.root, accountsRoot: fake.root }),
    context: zohoTestConnection(fake).context,
  };
}

it('extracts the 500-ticket native graph across cursor restarts, retains original mail and includes archived delta history', async () => {
  const full = await collectReference(connection);
  const tickets = full.filter((record) => record.entity === 'ticket');
  const contacts = full.filter((record) => record.entity === 'contact');
  const organizations = full.filter((record) => record.entity === 'organization');
  const messages = full.filter((record) => record.entity === 'message');
  const files = full.filter((record) => record.entity === 'attachment');
  const answers = full.filter((record) => record.entity === 'csat');
  const articles = full.filter((record) => record.entity === 'article');
  expect(tickets).toHaveLength(500);
  expect(contacts).toHaveLength(50);
  expect(organizations).toHaveLength(10);
  expect(full.filter((record) => record.entity === 'user')).toHaveLength(1);
  expect(full.filter((record) => record.entity === 'group')).toHaveLength(5);
  expect(full.filter((record) => record.entity === 'tag')).toHaveLength(6);
  expect(messages).toHaveLength(2000);
  expect(messages.filter((record) => !record.payload.public)).toHaveLength(500);
  expect(files).toHaveLength(500);
  expect(answers).toHaveLength(500);
  expect(articles).toHaveLength(40);
  expect(articles.filter((record) => record.payload.locale === 'en')).toHaveLength(20);
  expect(articles.filter((record) => record.payload.locale === 'ar')).toHaveLength(20);
  expect(new Set(articles.map((record) => record.payload.locale))).toEqual(new Set(['en', 'ar']));
  for (const source of fixture.tickets ?? []) {
    const ticket = tickets.find((record) => record.payload.externalId === source.id);
    expect(ticket?.payload).toMatchObject({
      number: source.ticketNumber,
      subject: source.subject,
      status: source.status,
      priority: source.priority,
      channel: 'EMAIL',
      requesterExternalId: source.contactId,
      organizationExternalId: source.accountId,
      assigneeExternalId: source.assigneeId,
      groupExternalId: source.departmentId,
      createdAt: source.createdTime,
      updatedAt: source.modifiedTime,
      ccExternalIds: [zohoCoreFixture.contacts[1]!.id],
      custom: source.cf,
    });
    const thread = messages.filter((record) => record.payload.ticketExternalId === source.id);
    expect(thread).toHaveLength(4);
    expect(
      thread.find((record) => record.payload.authorKind === 'customer')?.payload,
    ).toMatchObject({
      authorExternalId: source.contactId,
      createdAt: source.createdTime,
      email: { messageId: expect.stringContaining('@zoho-reference.example.invalid>') },
    });
    expect(thread.filter((record) => record.payload.authorKind === 'agent')).toHaveLength(2);
  }
  const english = articles.find((record) => record.payload.externalId === 'article:7001:en');
  expect(english?.payload).toMatchObject({
    assetOrigin: fake.root,
    published: { assetOrigin: fake.root, title: 'Published article' },
  });
  expect(english?.payload.published?.bodyHtml).not.toContain('Unpublished');
  const downloader = connection();
  expect(await downloader.connector.test(downloader.context)).toMatchObject({ ok: true });
  const beforeExpiry = fake.calls.filter((call) => call.path === '/oauth/v2/token').length;
  fake.expireToken();
  for (const file of [
    ...files.map(
      ({ payload: { ticketExternalId: _ticket, messageExternalId: _message, ...ref } }) => ref,
    ),
    ...articles.flatMap((record) => record.payload.attachments ?? []),
  ]) {
    const download = await downloader.connector.fetchAttachment(downloader.context, file);
    const chunks: Buffer[] = [];
    for await (const bytes of download.stream) chunks.push(Buffer.from(bytes));
    expect(Buffer.concat(chunks)).toEqual(zohoReferenceMedia);
  }
  expect(fake.calls.filter((call) => call.path === '/oauth/v2/token')).toHaveLength(
    beforeExpiry + 1,
  );
  const changedAt = new Date().toISOString();
  Object.assign(fake.fixture, zohoReferenceDelta(fixture, changedAt));
  const delta = await collectReference(connection, new Date(Date.parse(changedAt) - 60000));
  const active = fixture.tickets?.[0],
    archived = fixture.tickets?.[499];
  if (!active || !archived) throw new Error('Missing changed ticket reference');
  for (const id of [active.id, archived.id]) {
    expect(
      delta
        .filter((record) => record.entity === 'ticket')
        .find((record) => record.payload.externalId === id)?.payload,
    ).toMatchObject({ subject: `Delta subject ${id}`, status: 'Closed' });
    expect(
      delta
        .filter((record) => record.entity === 'message')
        .find((record) => record.payload.bodyText === `Delta note ${id}`)?.payload,
    ).toMatchObject({ public: false, createdAt: changedAt });
  }
  const original = answers.find((record) => record.payload.ticketExternalId === active.id);
  expect(
    delta
      .filter((record) => record.entity === 'csat')
      .find((record) => record.payload.ticketExternalId === active.id)?.payload,
  ).toMatchObject({ comment: 'Corrected original feedback', ratedAt: original?.payload.ratedAt });
  expect(
    delta
      .filter((record) => record.entity === 'contact')
      .find((record) => record.payload.externalId === active.contactId)?.payload.description,
  ).toBe('Delta contact description');
  expect(
    fake.calls
      .filter((call) => call.path === '/api/v1/tickets/archivedTickets')
      .some((call) => call.query.departmentId === '9007199254744000004'),
  ).toBe(true);
  expect(
    fake.calls.every(
      (call) =>
        call.method === 'GET' || (call.method === 'POST' && call.path === '/oauth/v2/token'),
    ),
  ).toBe(true);
}, 300000);
