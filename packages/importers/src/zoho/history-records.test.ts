import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { zohoCommentSchema, zohoThreadSchema, zohoTicketSchema } from './contracts.js';
import { readZohoThread, zohoEmailAddresses } from './history-content.js';
import { zohoCommentMessage, zohoThreadMessage } from './history-records.js';
import { zohoTestConnection } from './testing/context.js';
import { zohoCoreFixture } from './testing/core-fixture.js';
import { FakeZoho } from './testing/fake-zoho.js';

const ticketId = '9007199254740993001';
const threadId = '9007199254740993601';
const path = `/api/v1/tickets/${ticketId}/threads/${threadId}`;
const originalThread = {
  id: threadId,
  createdTime: '2013-11-01T11:21:07.000Z',
  visibility: 'public',
  direction: 'in',
  isDescriptionThread: true,
  status: 'SUCCESS',
  content: '<p>The original customer question</p>',
  plainText: 'The original customer question',
  contentType: 'text/html',
  isContentTruncated: false,
  author: { type: 'END_USER', name: 'Original customer', email: 'customer@example.test' },
  channel: 'EMAIL',
  fromEmailAddress: '"Original, customer" <customer@example.test>',
  to: 'Support <support@example.test>',
  cc: 'Other person <cc@example.test>',
  attachments: [],
};
let fake: FakeZoho;
beforeEach(async () => {
  fake = new FakeZoho({
    ...structuredClone(zohoCoreFixture),
    threads: { [ticketId]: [structuredClone(originalThread)] },
    originalMail: {
      [`${ticketId}:${threadId}`]: {
        date: 'Fri, 01 Nov 2013 14:21:07 +0300',
        returnPath: '<customer@example.test>',
        subject: 'Original mail subject',
        messageId: '<original-thread@example.test>',
        from: originalThread.fromEmailAddress,
        to: originalThread.to,
        content: 'Message-ID: <original-thread@example.test>\r\n\r\nOriginal MIME body',
      },
    },
  });
  await fake.start();
});
afterEach(async () => {
  await fake.close();
});

function ticket() {
  return zohoTicketSchema.parse(zohoCoreFixture.tickets[0]);
}

it('hydrates the original thread body, date, visibility, confirmed requester and complete recipient lists', async () => {
  const log = vi.fn();
  const { client } = zohoTestConnection(fake, { log });
  const loaded = await readZohoThread(client, ticketId, threadId);
  const message = await zohoThreadMessage(client, ticket(), loaded.thread, loaded.body);
  expect(message).toMatchObject({
    externalId: `thread:${threadId}`,
    ticketExternalId: ticketId,
    authorExternalId: '9007199254740993201',
    authorKind: 'customer',
    authorName: 'Original customer',
    public: true,
    bodyHtml: originalThread.content,
    createdAt: originalThread.createdTime,
    email: { from: 'customer@example.test', to: ['support@example.test'], cc: ['cc@example.test'] },
    sourceDetails: {
      status: 'SUCCESS',
      channel: 'EMAIL',
      direction: 'in',
      authorKind: 'customer',
      authorType: 'END_USER',
    },
  });
  expect(log).not.toHaveBeenCalled();
});

it.each(['DRAFT', 'PENDING', 'FAILED'])(
  'retains a %s source reply as private history with its unmodified body and source state',
  async (status) => {
    const log = vi.fn();
    const { client } = zohoTestConnection(fake, { log });
    const thread = zohoThreadSchema.parse({
      ...originalThread,
      status,
      direction: 'out',
      responderId: '9007199254740993301',
      author: { type: 'AGENT', name: 'Original agent' },
    });
    const message = await zohoThreadMessage(client, ticket(), thread, { bodyHtml: thread.content });
    expect(message).toMatchObject({
      authorKind: 'agent',
      authorExternalId: '9007199254740993301',
      public: false,
      bodyHtml: originalThread.content,
      sourceDetails: { status, direction: 'out', authorType: 'AGENT' },
    });
    expect(log).toHaveBeenCalledWith({
      level: 'warning',
      entity: 'message',
      externalId: `thread:${threadId}`,
      message: 'import.message.unsent-thread',
    });
  },
);

it('keeps an unresolved customer name without guessing that another ticket participant wrote the message', async () => {
  const log = vi.fn();
  const { client } = zohoTestConnection(fake, { log });
  const thread = zohoThreadSchema.parse({
    ...originalThread,
    author: { ...originalThread.author, email: 'another@example.test' },
  });
  const message = await zohoThreadMessage(client, ticket(), thread, { bodyHtml: thread.content });
  expect(message.authorExternalId).toBeUndefined();
  expect(message).toMatchObject({
    authorKind: 'system',
    authorName: 'Original customer',
    sourceDetails: { authorKind: 'customer', authorType: 'END_USER' },
  });
  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'import.message.identity-unavailable' }),
  );
});

it('preserves public and private comments at their original dates with author and parent-bound attachment references', async () => {
  const { client } = zohoTestConnection(fake);
  for (const isPublic of [false, true]) {
    const comment = zohoCommentSchema.parse({
      id: '7001',
      commentedTime: '2013-11-02T12:00:00Z',
      modifiedTime: null,
      isPublic,
      content: '<p>Original comment</p>',
      contentType: 'html',
      commenterId: '9007199254740993301',
      commenter: { type: 'AGENT', name: 'Original agent' },
      attachments: [
        {
          id: '8001',
          name: 'history.pdf',
          size: '2048',
          href: `${fake.root}/api/v1/tickets/${ticketId}/comments/7001/attachments/8001/content?orgId=${fake.fixture.orgId}`,
        },
      ],
    });
    const message = await zohoCommentMessage(client, ticket(), comment);
    expect(message).toMatchObject({
      externalId: 'comment:7001',
      public: isPublic,
      authorExternalId: '9007199254740993301',
      createdAt: comment.commentedTime,
      bodyHtml: comment.content,
      attachments: [{ fileName: 'history.pdf', size: 2048, url: comment.attachments[0]?.href }],
    });
  }
});

it.each([
  {
    native: 'text/html',
    mime: 'text/html',
    complete: '<p>The full original answer, including its final paragraph.</p>',
    expected: { bodyHtml: '<p>The full original answer, including its final paragraph.</p>' },
  },
  {
    native: 'html',
    mime: 'text/html',
    complete: '<p>The full original answer, including its final paragraph.</p>',
    expected: { bodyHtml: '<p>The full original answer, including its final paragraph.</p>' },
  },
  {
    native: 'plainText',
    mime: 'text/plain',
    complete: 'The full original answer, including its final paragraph.',
    expected: { bodyText: 'The full original answer, including its final paragraph.' },
  },
])(
  'retains complete $native content using its matching MIME type rather than the truncated detail',
  async ({ native, mime, complete, expected }) => {
    const log = vi.fn();
    const { client } = zohoTestConnection(fake, { log });
    fake.fixture.threads = {
      [ticketId]: [
        {
          ...originalThread,
          contentType: native,
          content: '<p>Truncated…</p>',
          isContentTruncated: true,
          fullContentURL: `${fake.root}${path}/fullContent`,
        },
      ],
    };
    fake.fixture.fullContent = {
      [`${ticketId}:${threadId}`]: { text: complete, contentType: `${mime}; charset=utf-8` },
    };
    const result = await readZohoThread(client, ticketId, threadId);
    expect(result.body).toEqual(expected);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'import.zoho.full-content-format-inferred' }),
    );
  },
);

it.each(['application/json', 'text/plain'])(
  'refuses a full-body response of %s instead of guessing or accepting the truncated fallback',
  async (contentType) => {
    const log = vi.fn();
    const { client } = zohoTestConnection(fake, { log });
    fake.fixture.threads = {
      [ticketId]: [
        {
          ...originalThread,
          isContentTruncated: true,
          fullContentURL: `${fake.root}${path}/fullContent`,
        },
      ],
    };
    fake.fixture.fullContent = {
      [`${ticketId}:${threadId}`]: { text: '{"content":"unverified envelope"}', contentType },
    };
    await expect(readZohoThread(client, ticketId, threadId)).rejects.toMatchObject({
      code: 'invalid-response',
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', message: 'import.zoho.full-content-unsupported' }),
    );
  },
);

it.each(['different-thread', 'different-origin', 'different-organization'] as const)(
  'refuses a %s full-content locator before sending its authenticated request',
  async (scenario) => {
    const { client } = zohoTestConnection(fake);
    const locator =
      scenario === 'different-thread'
        ? `${fake.root}/api/v1/tickets/${ticketId}/threads/999/fullContent`
        : scenario === 'different-origin'
          ? `https://attacker.example${path}/fullContent`
          : `${fake.root}${path}/fullContent?orgId=999`;
    fake.fixture.threads = {
      [ticketId]: [
        {
          ...originalThread,
          isContentTruncated: true,
          fullContentURL: locator,
        },
      ],
    };
    await expect(readZohoThread(client, ticketId, threadId)).rejects.toMatchObject({
      code: 'invalid-response',
    });
    expect(fake.calls.some((call) => call.path.endsWith('/fullContent'))).toBe(false);
  },
);

it('refuses invalid UTF-8 in a supposedly complete body instead of replacing bytes or storing the truncated fallback', async () => {
  const { client } = zohoTestConnection(fake);
  fake.fixture.threads = {
    [ticketId]: [
      {
        ...originalThread,
        isContentTruncated: true,
        fullContentURL: `${fake.root}${path}/fullContent`,
      },
    ],
  };
  fake.failNext({
    path: `${path}/fullContent`,
    status: 200,
    bytes: Buffer.from([0xc3, 0x28]),
    headers: { 'content-type': 'text/html' },
  });
  await expect(readZohoThread(client, ticketId, threadId)).rejects.toMatchObject({
    code: 'invalid-response',
  });
});

it.each([
  'a@example.test, <b@example.test> <c@example.test>',
  'Name <a@example.test> trailing',
  'a@example.test\r\nBcc: hidden@example.test',
])('refuses ambiguous recipient syntax without silently dropping an address: %s', (value) => {
  expect(() => zohoEmailAddresses(value)).toThrow('invalid-response');
});
