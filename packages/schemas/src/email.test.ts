import { describe, expect, it } from 'vitest';
import {
  emailMessageMetaSchema,
  genericInboundEmailSchema,
  imapTestRequestSchema,
  inboundParsePath,
  mailboxCreateRequestSchema,
  mailboxHealth,
  mailboxUpdateRequestSchema,
  remoteImageHosts,
  remoteImageParamSchema,
} from './email.js';

const DEPARTMENT = '0192c3f0-1a2b-7c3d-8e4f-0000000000d1';

describe('mailboxHealth', () => {
  const now = new Date('2026-09-27T12:00:00Z');
  const base = {
    method: 'imap' as const,
    pollIntervalSeconds: 60,
    createdAt: new Date('2026-09-27T11:00:00Z'),
    lastSuccessAt: new Date('2026-09-27T11:59:00Z'),
    lastErrorAt: null,
    lastReceivedAt: null,
  };

  it('is healthy within three intervals of the last success, and behind after', () => {
    expect(mailboxHealth(base, now)).toBe('healthy');
    expect(mailboxHealth({ ...base, lastSuccessAt: new Date('2026-09-27T11:56:00Z') }, now)).toBe(
      'behind',
    );
  });

  it('measures a mailbox never polled from its creation', () => {
    expect(
      mailboxHealth(
        { ...base, lastSuccessAt: null, createdAt: new Date('2026-09-27T11:59:30Z') },
        now,
      ),
    ).toBe('healthy');
    expect(mailboxHealth({ ...base, lastSuccessAt: null }, now)).toBe('behind');
  });

  it('is failing while the newest thing that happened is a failure', () => {
    expect(mailboxHealth({ ...base, lastErrorAt: new Date('2026-09-27T11:59:30Z') }, now)).toBe(
      'failing',
    );
    expect(mailboxHealth({ ...base, lastErrorAt: new Date('2026-09-27T11:58:00Z') }, now)).toBe(
      'healthy',
    );
  });

  it('waits for an inbound-parse mailbox’s first mail', () => {
    const parse = { ...base, method: 'inbound_parse' as const, lastSuccessAt: null };
    expect(mailboxHealth(parse, now)).toBe('waiting');
    expect(mailboxHealth({ ...parse, lastReceivedAt: now }, now)).toBe('healthy');
  });
});

describe('the mailbox requests', () => {
  const common = {
    address: ' Support@Helpdock.io ',
    displayName: 'Support',
    departmentId: DEPARTMENT,
  };

  it('lower-cases the address and fills the defaults', () => {
    expect(mailboxCreateRequestSchema.parse({ ...common, method: 'inbound_parse' })).toEqual({
      ...common,
      address: 'support@helpdock.io',
      method: 'inbound_parse',
      remoteImages: 'block',
      authFailureIsSpam: false,
      automatedAllowlist: [],
    });
  });

  it('needs a password to create an IMAP mailbox, and not to update one', () => {
    const imap = { host: 'imap.example.com', port: 993, security: 'tls', username: 'u' };
    expect(mailboxCreateRequestSchema.safeParse({ ...common, method: 'imap', imap }).success).toBe(
      false,
    );
    expect(
      mailboxUpdateRequestSchema.parse({ ...common, method: 'imap', imap }).imap,
    ).toMatchObject({
      folder: 'INBOX',
      pollIntervalSeconds: 60,
    });
    expect(
      mailboxUpdateRequestSchema.safeParse({
        ...common,
        method: 'imap',
        imap: { ...imap, pollIntervalSeconds: 45 },
      }).success,
    ).toBe(false);
  });

  it('refuses a Test IMAP with neither a password nor a saved mailbox', () => {
    const request = { host: 'imap.example.com', port: 993, security: 'tls', username: 'u' };
    expect(imapTestRequestSchema.safeParse(request).success).toBe(false);
    expect(imapTestRequestSchema.safeParse({ ...request, password: 'p' }).success).toBe(true);
    expect(imapTestRequestSchema.safeParse({ ...request, mailboxId: DEPARTMENT }).success).toBe(
      true,
    );
  });
});

describe('inbound parse', () => {
  it('names each provider’s path', () => {
    expect(inboundParsePath('postmark')).toBe('/internal/inbound-parse/postmark');
  });

  it('takes a raw message or a structured one, and nothing else', () => {
    expect(genericInboundEmailSchema.safeParse({ raw: 'From: a@b.co\r\n\r\nx' }).success).toBe(
      true,
    );
    expect(
      genericInboundEmailSchema.safeParse({
        from: { address: 'a@b.co' },
        to: [{ address: 'c@d.co' }],
      }).success,
    ).toBe(true);
    expect(genericInboundEmailSchema.safeParse({ subject: 'x' }).success).toBe(false);
  });
});

describe('the email card', () => {
  it('names each host once', () => {
    expect(
      remoteImageHosts([
        { url: 'https://a.example/1' },
        { url: 'https://a.example/2' },
        { url: 'http://b.example/3' },
      ]),
    ).toEqual(['a.example', 'b.example']);
  });

  it('refuses stored meta whose images are not URLs', () => {
    const meta = {
      from: { address: 'a@b.co', name: null },
      to: [],
      cc: [],
      date: null,
      quotedHtml: null,
      remoteImages: [{ url: 'not a url', alt: '' }],
      remoteImagePolicy: 'block',
      inlineAttachmentIds: [],
      authFailed: false,
      mismatch: null,
    };
    expect(emailMessageMetaSchema.safeParse(meta).success).toBe(false);
  });

  it('coerces the proxy index from the path and bounds it', () => {
    const ids = { brandId: DEPARTMENT, ticketId: DEPARTMENT, messageId: DEPARTMENT };
    expect(remoteImageParamSchema.parse({ ...ids, index: '3' }).index).toBe(3);
    expect(remoteImageParamSchema.safeParse({ ...ids, index: '-1' }).success).toBe(false);
  });
});
