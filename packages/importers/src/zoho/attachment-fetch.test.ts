import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchZohoAttachment } from './attachment-fetch.js';
import { zohoAttachmentSchema } from './contracts.js';
import { zohoAttachmentRef } from './history-records.js';
import { zohoTestConnection } from './testing/context.js';
import { zohoCoreFixture } from './testing/core-fixture.js';
import { FakeZoho } from './testing/fake-zoho.js';

let fake: FakeZoho;
const ticketId = '9007199254740993001';
const bytes = Buffer.from('%PDF-1.4\nSynthetic original history\n%%EOF');
beforeEach(async () => {
  fake = new FakeZoho(structuredClone(zohoCoreFixture));
  await fake.start();
});
afterEach(async () => {
  await fake.close();
});

function fixture(kind: 'threads' | 'comments') {
  const url = fake.addAttachment(
    { ticketId, kind, messageId: '6001', attachmentId: '9001' },
    bytes,
  );
  const file = { id: '9001', href: url, name: 'original.pdf', size: String(bytes.length) };
  if (kind === 'threads')
    fake.fixture.threads = {
      [ticketId]: [
        {
          id: '6001',
          createdTime: '2020-01-01T00:00:00Z',
          visibility: 'public',
          direction: 'in',
          isDescriptionThread: false,
          status: 'SUCCESS',
          content: 'History',
          contentType: 'text/plain',
          isContentTruncated: false,
          channel: 'EMAIL',
          author: null,
          attachments: [file],
        },
      ],
    };
  else
    fake.fixture.comments = {
      [ticketId]: [
        {
          id: '6001',
          commentedTime: '2020-01-01T00:00:00Z',
          modifiedTime: null,
          isPublic: false,
          content: 'Note',
          contentType: 'plainText',
          commenter: null,
          attachments: [file],
        },
      ],
    };
  return { file, path: new URL(url).pathname };
}

it.each(['threads', 'comments'] as const)(
  'refreshes a refused %s attachment through its documented parent and retains exact bytes',
  async (kind) => {
    const { file, path } = fixture(kind);
    const log = vi.fn();
    const { client } = zohoTestConnection(fake, { log });
    const ref = zohoAttachmentRef(client, ticketId, kind, '6001', zohoAttachmentSchema.parse(file));
    fake.failNext({ path, status: 403 });
    const result = await fetchZohoAttachment(client, ref);
    const received: Buffer[] = [];
    for await (const chunk of result.stream) received.push(Buffer.from(chunk));
    expect(Buffer.concat(received)).toEqual(bytes);
    expect(result.size).toBe(bytes.length);
    expect(result.contentType).toBe('application/pdf');
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'import.attachment.expired', externalId: ref.externalId }),
    );
    expect(fake.calls.filter((call) => call.path === path)).toHaveLength(2);
    expect(
      fake.calls
        .filter((call) => call.path === path || call.path.endsWith('/6001'))
        .every((call) => call.authenticated && call.orgId === fake.fixture.orgId),
    ).toBe(true);
  },
);

it('reports an asset still refused after metadata refresh as unavailable rather than returning error bytes', async () => {
  const { file, path } = fixture('threads');
  const { client } = zohoTestConnection(fake);
  const ref = zohoAttachmentRef(
    client,
    ticketId,
    'threads',
    '6001',
    zohoAttachmentSchema.parse(file),
  );
  fake.failNext({ path, status: 403 });
  fake.failNext({ path, status: 403 });
  await expect(fetchZohoAttachment(client, ref)).rejects.toMatchObject({
    code: 'record-unavailable',
  });
  expect(fake.calls.filter((call) => call.path === path)).toHaveLength(2);
});

it('does not continue a stale attachment after its documented filename or size changes', async () => {
  const { file, path } = fixture('threads');
  const { client } = zohoTestConnection(fake);
  const ref = zohoAttachmentRef(
    client,
    ticketId,
    'threads',
    '6001',
    zohoAttachmentSchema.parse({ ...file, size: String(bytes.length + 1) }),
  );
  fake.failNext({ path, status: 403 });
  await expect(fetchZohoAttachment(client, ref)).rejects.toMatchObject({
    code: 'invalid-response',
  });
  expect(fake.calls.filter((call) => call.path === path)).toHaveLength(1);
});

it('refuses an attachment body whose size differs from source metadata', async () => {
  const { file } = fixture('threads');
  const { client } = zohoTestConnection(fake);
  const ref = zohoAttachmentRef(
    client,
    ticketId,
    'threads',
    '6001',
    zohoAttachmentSchema.parse({ ...file, size: String(bytes.length + 1) }),
  );
  await expect(fetchZohoAttachment(client, ref)).rejects.toMatchObject({
    code: 'invalid-response',
  });
});

it('refuses a forged asset parent before requesting an access token or sending credentials', async () => {
  const { file } = fixture('threads');
  const { client } = zohoTestConnection(fake);
  const ref = zohoAttachmentRef(
    client,
    ticketId,
    'threads',
    '6001',
    zohoAttachmentSchema.parse(file),
  );
  await expect(
    fetchZohoAttachment(client, {
      ...ref,
      url: `${fake.root}/api/v1/tickets/${ticketId}/threads/9999/attachments/9001/content`,
    }),
  ).rejects.toMatchObject({ code: 'invalid-response' });
  expect(fake.calls).toEqual([]);
});

it.each([429, 503])(
  'preserves a %s asset failure for the resumable worker rather than marking the file unavailable',
  async (status) => {
    const { file, path } = fixture('comments');
    const { client } = zohoTestConnection(fake);
    const ref = zohoAttachmentRef(
      client,
      ticketId,
      'comments',
      '6001',
      zohoAttachmentSchema.parse(file),
    );
    fake.failNext({ path, status, headers: { 'Retry-After': '3' } });
    await expect(fetchZohoAttachment(client, ref)).rejects.toMatchObject(
      status === 429 ? { retryAfterMs: 3000 } : { code: 'vendor-unavailable' },
    );
    expect(fake.calls.filter((call) => call.path === path)).toHaveLength(1);
  },
);
