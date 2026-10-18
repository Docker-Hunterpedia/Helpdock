import type { ImportRecord } from '@helpdock/schemas';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ImportCursor } from '../connector.js';
import { collectAsync } from '../testing/collect.js';
import { fetchZohoAttachment } from './attachment-fetch.js';
import { zohoTicketAttachmentSchema } from './contracts.js';
import { exportZohoHistory } from './history-export.js';
import { zohoTestConnection } from './testing/context.js';
import { zohoCoreFixture } from './testing/core-fixture.js';
import { FakeZoho } from './testing/fake-zoho.js';
import { zohoTicketAttachmentMessage, zohoTicketAttachmentRef } from './ticket-attachments.js';

const ticketId = zohoCoreFixture.tickets[0]!.id;
const bytes = Buffer.from('%PDF-1.4\nOriginal ticket attachment\n%%EOF');
let fake: FakeZoho;
beforeEach(async () => {
  fake = new FakeZoho({
    ...structuredClone(zohoCoreFixture),
    tickets: [{ ...structuredClone(zohoCoreFixture.tickets[0]!), description: null }],
  });
  await fake.start();
});
afterEach(async () => {
  await fake.close();
});

function files(count = 1) {
  fake.fixture.ticketAttachments = {
    [ticketId]: Array.from({ length: count }, (_, index) => ({
      id: String(10000 + index),
      name: `original-${index}.pdf`,
      size: String(bytes.length),
      createdTime: new Date(Date.parse('2013-11-01T00:00:00Z') + index * 1000).toISOString(),
      isPublic: index % 2 === 0,
      creatorId: '9007199254740993301',
      creator: {
        id: '9007199254740993301',
        firstName: 'Original',
        lastName: 'Creator',
        email: 'original@example.test',
      },
      href: fake.addTicketAttachment(ticketId, String(10000 + index), bytes),
    })),
  };
  return zohoTicketAttachmentSchema.parse(fake.fixture.ticketAttachments[ticketId]![0]);
}

it('retains ticket-only files as dated attachment-only history with original visibility and source-only creator', async () => {
  files(2);
  const log = vi.fn(async () => {});
  const { client } = zohoTestConnection(fake, { log });
  const messages = (
    await collectAsync(exportZohoHistory(client, { mode: 'message', cursor: null }))
  ).flatMap((page) => page.records);
  expect(messages).toHaveLength(2);
  expect(messages[0]).toMatchObject({
    entity: 'message',
    payload: {
      externalId: 'ticket-attachment:10000',
      ticketExternalId: ticketId,
      authorKind: 'system',
      authorName: 'Original Creator',
      sourceDetails: { authorKind: 'unknown', authorType: 'USER:9007199254740993301' },
      public: true,
      bodyText: '',
      createdAt: '2013-11-01T00:00:00.000Z',
      attachments: [{ externalId: `t:${ticketId}:ticket:a:10000`, sourcePage: 1 }],
    },
  });
  expect(messages[1]).toMatchObject({ payload: { public: false } });
  const attachments = (
    await collectAsync(exportZohoHistory(client, { mode: 'attachment', cursor: null }))
  ).flatMap((page) => page.records);
  expect(attachments).toHaveLength(2);
  expect(attachments[0]).toMatchObject({
    entity: 'attachment',
    payload: {
      externalId: `t:${ticketId}:ticket:a:10000`,
      messageExternalId: 'ticket-attachment:10000',
      sourcePage: 1,
    },
  });
  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({
      message: 'import.message.identity-unavailable',
      externalId: 'ticket-attachment:10000',
    }),
  );
});

it('resumes through 101 ticket-level files without losing or repeating a committed relationship', async () => {
  files(101);
  const { client } = zohoTestConnection(fake);
  const committed: ImportRecord[] = [];
  let checkpoint: ImportCursor | null = null;
  for await (const page of exportZohoHistory(client, { mode: 'attachment', cursor: null })) {
    committed.push(...page.records);
    checkpoint = page.cursor;
    if (committed.length === 36) break;
  }
  const resumed = (
    await collectAsync(
      exportZohoHistory(client, {
        mode: 'attachment',
        cursor: JSON.parse(JSON.stringify(checkpoint)),
      }),
    )
  ).flatMap((page) => page.records);
  expect([...committed, ...resumed]).toHaveLength(101);
  expect(new Set([...committed, ...resumed].map((record) => record.payload.externalId)).size).toBe(
    101,
  );
  expect(resumed.at(-1)).toMatchObject({
    payload: { sourcePage: 2, messageExternalId: 'ticket-attachment:10100' },
  });
});

it('refreshes a refused ticket-level download through the bounded source page and returns the original bytes', async () => {
  const file = files();
  const { client } = zohoTestConnection(fake);
  const ref = zohoTicketAttachmentRef(client, ticketId, file, 0);
  fake.failNext({ path: new URL(file.href).pathname, status: 410 });
  const result = await fetchZohoAttachment(client, ref);
  const received: Buffer[] = [];
  for await (const chunk of result.stream) received.push(Buffer.from(chunk));
  expect(Buffer.concat(received)).toEqual(bytes);
  expect(
    fake.calls.filter((call) => call.path === `/api/v1/tickets/${ticketId}/attachments`),
  ).toHaveLength(1);
});

it('treats a missing refreshed page entry as a stale snapshot rather than a missing-file placeholder', async () => {
  const file = files();
  const { client } = zohoTestConnection(fake);
  const ref = zohoTicketAttachmentRef(client, ticketId, file, 0);
  fake.fixture.ticketAttachments = {};
  fake.failNext({ path: new URL(file.href).pathname, status: 410 });
  await expect(fetchZohoAttachment(client, ref)).rejects.toMatchObject({
    code: 'invalid-response',
  });
});

it('rejects a forged root locator before token retrieval and refuses conflicting creator identities', async () => {
  const file = files();
  const { client } = zohoTestConnection(fake);
  const ref = zohoTicketAttachmentRef(client, ticketId, file, 0);
  await expect(
    fetchZohoAttachment(client, {
      ...ref,
      url: `${fake.root}/api/v1/tickets/9999/attachments/${file.id}/content`,
    }),
  ).rejects.toMatchObject({ code: 'invalid-response' });
  expect(fake.calls).toEqual([]);
  await expect(
    zohoTicketAttachmentMessage(client, ticketId, { ...file, creatorId: '9999' }, 0),
  ).rejects.toMatchObject({ code: 'invalid-response' });
});
