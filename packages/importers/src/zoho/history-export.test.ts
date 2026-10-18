import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ImportCursor } from '../connector.js';
import { collectAsync } from '../testing/collect.js';
import type { TicketInventory } from '../ticket-inventory.js';
import { exportZohoHistory } from './history-export.js';
import { zohoTestConnection } from './testing/context.js';
import { zohoCoreFixture } from './testing/core-fixture.js';
import { FakeZoho } from './testing/fake-zoho.js';

const ticketId = '9007199254740993001';
let fake: FakeZoho;
beforeEach(async () => {
  fake = new FakeZoho({
    ...structuredClone(zohoCoreFixture),
    tickets: structuredClone(zohoCoreFixture.tickets.slice(0, 1)),
  });
  await fake.start();
  const start = Date.parse('2013-11-01T11:21:07.000Z');
  const threads = Array.from({ length: 201 }, (_, index) => ({
    id: String(6000 + index),
    createdTime: new Date(start + index * 1000).toISOString(),
    visibility: index === 1 ? 'private' : 'public',
    direction: index === 1 ? 'out' : 'in',
    isDescriptionThread: index === 0,
    status: 'SUCCESS',
    content: `<p>Original thread ${index}</p>`,
    contentType: 'text/html',
    isContentTruncated: false,
    channel: 'EMAIL',
    fromEmailAddress: index === 1 ? 'agent@example.test' : 'customer@example.test',
    to: index === 1 ? 'customer@example.test' : 'support@example.test',
    author:
      index === 1
        ? { type: 'AGENT', name: 'Original agent' }
        : { type: 'END_USER', name: 'Original customer', email: 'customer@example.test' },
    ...(index === 1 ? { responderId: '9007199254740993301' } : {}),
    attachments:
      index === 0
        ? [
            {
              id: '9001',
              name: 'thread.pdf',
              size: '42',
              href: `${fake.root}/api/v1/tickets/${ticketId}/threads/6000/attachments/9001/content`,
            },
          ]
        : [],
  }));
  fake.fixture.threads = { [ticketId]: threads };
  fake.fixture.originalMail = Object.fromEntries(
    threads.map((thread) => [
      `${ticketId}:${thread.id}`,
      {
        date: new Date(thread.createdTime).toUTCString(),
        returnPath: `<${thread.fromEmailAddress}>`,
        subject: 'Original question',
        messageId: `<${thread.id}@source.example.test>`,
        from: thread.fromEmailAddress,
        to: thread.to,
        content: 'Original MIME fixture',
      },
    ]),
  );
  fake.fixture.comments = {
    [ticketId]: Array.from({ length: 101 }, (_, index) => ({
      id: String(6000 + index),
      commentedTime: new Date(start + 300_000 + index * 1000).toISOString(),
      modifiedTime: null,
      isPublic: index % 2 === 0,
      content: `Original comment ${index}`,
      contentType: 'plainText',
      commenterId: '9007199254740993301',
      commenter: { type: 'AGENT', name: 'Original agent' },
      attachments:
        index === 100
          ? [
              {
                id: '9002',
                name: 'comment.pdf',
                size: '43',
                href: `${fake.root}/api/v1/tickets/${ticketId}/comments/6100/attachments/9002/content`,
              },
            ]
          : [],
    })),
  };
});
afterEach(async () => {
  await fake.close();
});

it('extracts paged public/private threads and comments, hydrates full bodies and does not duplicate the description thread', async () => {
  const { client } = zohoTestConnection(fake);
  const records = (
    await collectAsync(exportZohoHistory(client, { mode: 'message', cursor: null }))
  ).flatMap((page) => page.records);
  expect(records).toHaveLength(302);
  expect(new Set(records.map((record) => record.payload.externalId)).size).toBe(302);
  expect(records[1]).toMatchObject({
    entity: 'message',
    payload: {
      externalId: 'thread:6001',
      public: false,
      authorKind: 'agent',
      authorExternalId: '9007199254740993301',
      bodyHtml: '<p>Original thread 1</p>',
    },
  });
  expect(records.at(-1)).toMatchObject({
    entity: 'message',
    payload: {
      externalId: 'comment:6100',
      bodyText: 'Original comment 100',
      attachments: [{ fileName: 'comment.pdf', size: 43 }],
    },
  });
  expect(records.some((record) => record.payload.externalId.startsWith('description:'))).toBe(
    false,
  );
  // One list page is reused only within the active iterator; a resumed worker revalidates it.
  expect(
    fake.calls.filter((call) => call.path === `/api/v1/tickets/${ticketId}/threads`),
  ).toHaveLength(2);
  expect(
    fake.calls.filter((call) => call.path === `/api/v1/tickets/${ticketId}/comments`),
  ).toHaveLength(2);
});

it('resumes an interrupted thread page and reaches later comment pages without dropping or repeating a committed message', async () => {
  const first = zohoTestConnection(fake);
  let cursor: ImportCursor | null = null;
  const committed: string[] = [];
  for await (const page of exportZohoHistory(first.client, { mode: 'message', cursor: null })) {
    cursor = page.cursor;
    committed.push(...page.records.map((record) => record.payload.externalId));
    if (committed.length === 51) break;
  }
  const resumed = zohoTestConnection(fake);
  const remaining = (
    await collectAsync(
      exportZohoHistory(resumed.client, {
        mode: 'message',
        cursor: JSON.parse(JSON.stringify(cursor)),
      }),
    )
  ).flatMap((page) => page.records.map((record) => record.payload.externalId));
  expect([...committed, ...remaining]).toEqual([
    ...Array.from({ length: 201 }, (_, index) => `thread:${6000 + index}`),
    ...Array.from({ length: 101 }, (_, index) => `comment:${6000 + index}`),
  ]);
});

it('refuses a changed saved page instead of moving an offset into a different source history', async () => {
  const log = vi.fn();
  const first = zohoTestConnection(fake);
  let cursor: ImportCursor | null = null;
  for await (const page of exportZohoHistory(first.client, { mode: 'message', cursor: null })) {
    cursor = page.cursor;
    if (page.records.length) break;
  }
  const source = fake.fixture.threads?.[ticketId]?.[0];
  if (!source) throw new Error('Missing source history');
  source.visibility = 'private';
  const resumed = zohoTestConnection(fake, { log });
  await expect(
    collectAsync(exportZohoHistory(resumed.client, { mode: 'message', cursor })),
  ).rejects.toMatchObject({ code: 'invalid-response' });
  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({ level: 'error', message: 'import.zoho.history-page-changed' }),
  );
});

it('extracts attachment references without fetching or interpreting truncated message bodies', async () => {
  const source = fake.fixture.threads?.[ticketId]?.[0];
  if (!source) throw new Error('Missing source history');
  source.isContentTruncated = true;
  source.fullContentURL = 'https://attacker.example/never-read-for-attachments';
  const { client } = zohoTestConnection(fake);
  const records = (
    await collectAsync(exportZohoHistory(client, { mode: 'attachment', cursor: null }))
  ).flatMap((page) => page.records);
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({
    entity: 'attachment',
    payload: {
      ticketExternalId: ticketId,
      messageExternalId: 'thread:6000',
      fileName: 'thread.pdf',
      size: 42,
    },
  });
  expect(records[1]).toMatchObject({
    entity: 'attachment',
    payload: { messageExternalId: 'comment:6100', fileName: 'comment.pdf' },
  });
  expect(fake.calls.some((call) => call.path.endsWith('/fullContent'))).toBe(false);
});

it('retains a description without a source thread as private, unattributed history and requires review', async () => {
  fake.fixture.threads = {};
  fake.fixture.comments = {};
  const log = vi.fn();
  const { client } = zohoTestConnection(fake, { log });
  const records = (
    await collectAsync(exportZohoHistory(client, { mode: 'message', cursor: null }))
  ).flatMap((page) => page.records);
  expect(records).toEqual([
    expect.objectContaining({
      entity: 'message',
      payload: expect.objectContaining({
        externalId: `description:${ticketId}`,
        public: false,
        authorKind: 'system',
        sourceDetails: { authorKind: 'unknown' },
        bodyHtml: '<p>The original question</p>',
        createdAt: '2013-11-01T11:21:07.000Z',
      }),
    }),
  ]);
  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'import.zoho.description-fallback' }),
  );
});

it.each(['automatic', 'complete-inventory'] as const)(
  'keeps archived delta history through %s discovery even when its original ticket date is old',
  async (discovery) => {
    const archived = zohoCoreFixture.tickets[2];
    const sample = fake.fixture.threads?.[ticketId]?.[0];
    if (!archived || !sample) throw new Error('Missing archive history fixture');
    fake.fixture.tickets?.push(structuredClone(archived));
    fake.fixture.threads = {
      [archived.id]: [
        { ...sample, id: '7001', attachments: [], content: '<p>Original archived history</p>' },
      ],
    };
    const original = fake.fixture.originalMail?.[`${ticketId}:${sample.id}`];
    if (!original) throw new Error('Missing original archive mail fixture');
    fake.fixture.originalMail = {
      [`${archived.id}:7001`]: { ...original, messageId: '<archived-7001@source.example.test>' },
    };
    const inventory: TicketInventory = {
      mode: 'complete',
      fingerprint: 'a'.repeat(64),
      next: async (after) =>
        after === null ? { externalId: archived.id, location: 'archived' } : null,
    };
    const { client } = zohoTestConnection(fake);
    const records = (
      await collectAsync(
        exportZohoHistory(client, {
          mode: 'message',
          cursor: null,
          since: new Date('2026-01-01T00:00:00Z'),
          ...(discovery === 'complete-inventory' ? { inventory } : {}),
        }),
      )
    ).flatMap((page) => page.records);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      entity: 'message',
      payload: {
        ticketExternalId: archived.id,
        externalId: 'thread:7001',
        bodyHtml: '<p>Original archived history</p>',
      },
    });
    expect(
      fake.calls.some((call) => ['/api/v1/tickets', '/api/v1/tickets/search'].includes(call.path)),
    ).toBe(discovery === 'automatic');
    expect(fake.calls.some((call) => call.path === '/api/v1/tickets/archivedTickets')).toBe(
      discovery === 'automatic',
    );
  },
);
