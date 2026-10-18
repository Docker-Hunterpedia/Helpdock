import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { zohoThreadSchema } from './contracts.js';
import { readZohoOriginalMail } from './original-mail.js';
import { zohoTestConnection } from './testing/context.js';
import { zohoCoreFixture } from './testing/core-fixture.js';
import { FakeZoho } from './testing/fake-zoho.js';

const ticketId = '9007199254740993001';
const thread = zohoThreadSchema.parse({
  id: '7001',
  createdTime: '2013-11-01T11:21:07.000Z',
  visibility: 'public',
  direction: 'in',
  isDescriptionThread: true,
  status: 'SUCCESS',
  content: '<p>Rendered body</p>',
  contentType: 'html',
  isContentTruncated: false,
  author: { type: 'END_USER', name: 'Original customer' },
  channel: 'EMAIL',
  fromEmailAddress: '"Original, Customer" <customer@example.test>',
  to: 'Support <support@example.test>',
  cc: 'copy@example.test',
  attachments: [],
});
const original = {
  date: 'Fri, 01 Nov 2013 15:00:00 +0530',
  returnPath: '<bounce@example.test>',
  subject: 'Original email subject',
  messageId: '<original.7001@source.example.test>',
  from: 'Original Customer <customer@example.test>',
  to: 'support@example.test',
  content: 'Message-ID: <original.7001@source.example.test>\r\n\r\nDo not stage this raw MIME.',
};
const path = `/api/v1/tickets/${ticketId}/threads/${thread.id}/originalContent`;
let fake: FakeZoho;
beforeEach(async () => {
  fake = new FakeZoho({
    ...structuredClone(zohoCoreFixture),
    originalMail: { [`${ticketId}:${thread.id}`]: { ...original } },
  });
  await fake.start();
});
afterEach(async () => {
  await fake.close();
});

it('preserves original message identity, separate sent date and inert source headers without staging raw MIME', async () => {
  const { client } = zohoTestConnection(fake);
  const mail = await readZohoOriginalMail(client, ticketId, thread);
  expect(mail).toEqual({
    email: {
      messageId: original.messageId,
      from: 'customer@example.test',
      to: ['support@example.test'],
      cc: ['copy@example.test'],
      sentAt: '2013-11-01T09:30:00.000Z',
    },
    details: {
      mailSubject: original.subject,
      mailDate: original.date,
      mailReturnPath: original.returnPath,
    },
  });
  expect(JSON.stringify(mail)).not.toContain('Do not stage');
  expect(fake.calls.find((call) => call.path === path)).toMatchObject({
    method: 'GET',
    query: { inline: 'false' },
    authenticated: true,
    orgId: fake.fixture.orgId,
  });
});

it.each([404, 410])(
  'warns explicitly when original mail is unavailable with HTTP %s without inventing identity',
  async (status) => {
    const log = vi.fn();
    const { client } = zohoTestConnection(fake, { log });
    fake.failNext({ path, status });
    expect(await readZohoOriginalMail(client, ticketId, thread)).toEqual({});
    expect(log).toHaveBeenCalledWith({
      level: 'warning',
      entity: 'message',
      externalId: 'thread:7001',
      message: 'import.zoho.original-mail-unavailable',
    });
  },
);

it.each([403, 429, 503])(
  'does not turn original-mail HTTP %s into successful fallback',
  async (status) => {
    const log = vi.fn();
    const { client } = zohoTestConnection(fake, { log });
    fake.failNext({ path, status, headers: { 'Retry-After': '2' } });
    await expect(readZohoOriginalMail(client, ticketId, thread)).rejects.toMatchObject(
      status === 429
        ? { retryAfterMs: 2000 }
        : { code: status === 403 ? 'credentials-refused' : 'vendor-unavailable' },
    );
    expect(log).not.toHaveBeenCalled();
  },
);

it.each([404, 410])(
  'does not mistake OAuth endpoint HTTP %s for missing original mail',
  async (status) => {
    const log = vi.fn();
    const { client } = zohoTestConnection(fake, { log });
    fake.failNext({ path: '/oauth/v2/token', status });
    await expect(readZohoOriginalMail(client, ticketId, thread)).rejects.toMatchObject({
      code: 'invalid-response',
    });
    expect(log).not.toHaveBeenCalled();
    expect(fake.calls.some((call) => call.path === path)).toBe(false);
  },
);

it.each([
  { channel: 'CHAT', status: 'SUCCESS' },
  { channel: 'EMAIL', status: 'DRAFT' },
  { channel: 'EMAIL', status: 'FAILED' },
])('does not request original mail for $channel/$status', async (overrides) => {
  const { client } = zohoTestConnection(fake);
  expect(await readZohoOriginalMail(client, ticketId, { ...thread, ...overrides })).toEqual({});
  expect(fake.calls).toEqual([]);
});

it.each(['from', 'to', 'messageId'] as const)(
  'refuses a mismatched or unsafe original %s before emitting mail metadata',
  async (field) => {
    const { client } = zohoTestConnection(fake);
    fake.fixture.originalMail = {
      [`${ticketId}:${thread.id}`]: {
        ...original,
        [field]:
          field === 'messageId'
            ? '<injected@example.test>\r\nBcc: hidden@example.test'
            : 'different@example.test',
      },
    };
    await expect(readZohoOriginalMail(client, ticketId, thread)).rejects.toMatchObject({
      code: 'invalid-response',
    });
  },
);

it('retains an unparseable source date as provenance and warns instead of substituting the migration or thread time', async () => {
  const log = vi.fn();
  const { client } = zohoTestConnection(fake, { log });
  fake.fixture.originalMail = {
    [`${ticketId}:${thread.id}`]: { ...original, date: 'Unknown source time' },
  };
  expect(await readZohoOriginalMail(client, ticketId, thread)).toMatchObject({
    email: { sentAt: null },
    details: { mailDate: 'Unknown source time' },
  });
  expect(log).toHaveBeenCalledWith({
    level: 'warning',
    entity: 'message',
    externalId: 'thread:7001',
    message: 'import.zoho.mail-date-unparsed',
  });
});
