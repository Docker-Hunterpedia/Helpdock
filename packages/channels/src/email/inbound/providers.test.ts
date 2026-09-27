import { describe, expect, it } from 'vitest';
import {
  InboundBodyMissingError,
  type InboundPayload,
  InboundPayloadError,
  type InboundUpload,
  parseAddressList,
  parseInboundPayload,
} from './providers.js';

const RAW = [
  'From: Mona <mona@example.com>',
  'To: support@helpdock.test',
  'Subject: Raw hello',
  'Message-ID: <raw-1@example.com>',
  '',
  'Raw body',
  '',
].join('\r\n');

const form = (
  fields: Record<string, string>,
  files: Record<string, InboundUpload> = {},
): InboundPayload => ({
  kind: 'form',
  fields: new Map(Object.entries(fields)),
  files: new Map(Object.entries(files)),
});

const json = (body: unknown): InboundPayload => ({ kind: 'json', body });

describe('parseAddressList', () => {
  it('splits on commas outside quoted names and lower-cases the addresses', () => {
    expect(
      parseAddressList('"Khalil, Mona" <Mona@Example.com>, b@example.com, not-an-address'),
    ).toEqual([
      { address: 'mona@example.com', name: 'Khalil, Mona' },
      { address: 'b@example.com', name: null },
    ]);
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList(undefined)).toEqual([]);
  });
});

describe('Postmark', () => {
  const body = {
    FromFull: { Email: 'Mona@Example.com', Name: 'Mona' },
    ToFull: [{ Email: 'support@helpdock.test', Name: '' }],
    CcFull: [{ Email: 'karim@example.com' }],
    OriginalRecipient: 'hidden@helpdock.test',
    Subject: 'Refund',
    Date: 'Tue, 15 Sep 2026 10:00:00 +0000',
    HtmlBody: '<p>Hi</p>',
    TextBody: 'Hi',
    MessageID: 'postmark-own-id',
    Headers: [
      { Name: 'Message-ID', Value: '<sender-id@example.com>' },
      { Name: 'In-Reply-To', Value: '<sent@helpdock.test>' },
      { Name: 'References', Value: '<root@helpdock.test> <sent@helpdock.test>' },
    ],
    Attachments: [
      {
        Name: 'a.png',
        Content: Buffer.from('png').toString('base64'),
        ContentType: 'image/png',
        ContentID: 'img1@x',
      },
      {
        Name: 'b.pdf',
        Content: Buffer.from('pdf').toString('base64'),
        ContentType: 'application/pdf',
      },
    ],
  };

  it('reads the sender’s own Message-ID from the headers, not Postmark’s', async () => {
    const { email, recipients } = await parseInboundPayload('postmark', json(body));

    expect(email.messageId).toBe('sender-id@example.com');
    expect(email.inReplyTo).toBe('sent@helpdock.test');
    expect(email.references).toEqual(['root@helpdock.test', 'sent@helpdock.test']);
    expect(email.from).toEqual({ address: 'mona@example.com', name: 'Mona' });
    expect(email.cc).toEqual([{ address: 'karim@example.com', name: null }]);
    expect(recipients).toEqual([
      'hidden@helpdock.test',
      'support@helpdock.test',
      'karim@example.com',
    ]);
    expect(email.attachments.map((file) => [file.filename, file.contentId, file.inline])).toEqual([
      ['a.png', 'img1@x', true],
      ['b.pdf', null, false],
    ]);
    expect(email.attachments[0]?.content.toString()).toBe('png');
  });

  it('prefers RawEmail when the stream includes it', async () => {
    const { email } = await parseInboundPayload('postmark', json({ ...body, RawEmail: RAW }));
    expect(email.messageId).toBe('raw-1@example.com');
  });

  it('falls back to the plain From line and refuses a form body', async () => {
    const { email } = await parseInboundPayload(
      'postmark',
      json({ From: 'Mona <mona@example.com>', TextBody: 'Hi' }),
    );
    expect(email.from?.address).toBe('mona@example.com');
    expect(email.messageId).toMatch(/\.invalid$/);
    await expect(parseInboundPayload('postmark', form({}))).rejects.toBeInstanceOf(
      InboundPayloadError,
    );
    await expect(parseInboundPayload('postmark', json({ ToFull: 'no' }))).rejects.toBeInstanceOf(
      InboundPayloadError,
    );
  });
});

describe('SendGrid', () => {
  it('parses the raw email field when "Send raw" is on', async () => {
    const { email, recipients } = await parseInboundPayload(
      'sendgrid',
      form({ email: RAW, envelope: JSON.stringify({ to: ['env@helpdock.test'], from: 'x' }) }),
    );

    expect(email.subject).toBe('Raw hello');
    expect(recipients[0]).toBe('env@helpdock.test');
  });

  it('builds the message from the parsed fields otherwise', async () => {
    const { email } = await parseInboundPayload(
      'sendgrid',
      form(
        {
          from: 'Mona <mona@example.com>',
          to: 'support@helpdock.test',
          cc: 'karim@example.com',
          subject: 'Fields',
          html: '<p>Hi</p>',
          text: 'Hi',
          headers:
            'Message-ID: <sg-1@example.com>\nIn-Reply-To: <sent@helpdock.test>\nDate: Tue, 15 Sep 2026 10:00:00 +0000\nX-Folded: a\n b',
          'attachment-info': JSON.stringify({ attachment1: { 'content-id': '<img@x>' } }),
          envelope: 'not json',
        },
        {
          attachment1: { filename: 'i.png', contentType: 'image/png', content: Buffer.from('i') },
          attachment2: { filename: 'f.txt', contentType: 'text/plain', content: Buffer.from('f') },
          other: { filename: 'ignored', contentType: 'text/plain', content: Buffer.from('') },
        },
      ),
    );

    expect(email.messageId).toBe('sg-1@example.com');
    expect(email.inReplyTo).toBe('sent@helpdock.test');
    expect(email.headers.get('x-folded')).toEqual(['a b']);
    expect(email.date?.toISOString()).toBe('2026-09-15T10:00:00.000Z');
    expect(email.attachments.map((file) => [file.filename, file.contentId])).toEqual([
      ['i.png', 'img@x'],
      ['f.txt', null],
    ]);
  });

  it('refuses JSON and a form with no sender', async () => {
    await expect(parseInboundPayload('sendgrid', json({}))).rejects.toBeInstanceOf(
      InboundPayloadError,
    );
    await expect(parseInboundPayload('sendgrid', form({ subject: 'x' }))).rejects.toBeInstanceOf(
      InboundPayloadError,
    );
  });
});

describe('Mailgun', () => {
  it('parses body-mime from a mime route', async () => {
    const { email, recipients } = await parseInboundPayload(
      'mailgun',
      form({ 'body-mime': RAW, recipient: 'support@helpdock.test' }),
    );

    expect(email.messageId).toBe('raw-1@example.com');
    expect(recipients).toEqual(['support@helpdock.test']);
  });

  it('builds the message from the parsed fields and the content-id map', async () => {
    const { email } = await parseInboundPayload(
      'mailgun',
      form(
        {
          sender: 'mona@example.com',
          from: 'Mona <mona@example.com>',
          recipient: 'support@helpdock.test',
          subject: 'Fields',
          'body-plain': 'Hi',
          'body-html': '<p>Hi</p>',
          'message-headers': JSON.stringify([
            ['Message-Id', '<mg-1@example.com>'],
            ['To', 'support@helpdock.test'],
            ['Cc', 'karim@example.com'],
            ['References', '<root@helpdock.test>'],
          ]),
          'content-id-map': JSON.stringify({ '<img@x>': 'attachment-1' }),
        },
        {
          'attachment-1': {
            filename: 'i.png',
            contentType: 'image/png',
            content: Buffer.from('i'),
          },
        },
      ),
    );

    expect(email.messageId).toBe('mg-1@example.com');
    expect(email.cc.map((cc) => cc.address)).toEqual(['karim@example.com']);
    expect(email.references).toEqual(['root@helpdock.test']);
    expect(email.attachments[0]).toMatchObject({ contentId: 'img@x', inline: true });
  });

  it('survives malformed header JSON and refuses a form with no sender', async () => {
    const { email } = await parseInboundPayload(
      'mailgun',
      form({ sender: 'mona@example.com', 'message-headers': '{', 'content-id-map': '[' }),
    );
    expect(email.from?.address).toBe('mona@example.com');
    await expect(parseInboundPayload('mailgun', form({}))).rejects.toBeInstanceOf(
      InboundPayloadError,
    );
    await expect(parseInboundPayload('mailgun', json({}))).rejects.toBeInstanceOf(
      InboundPayloadError,
    );
  });
});

describe('Resend', () => {
  const data = {
    from: 'Mona <mona@example.com>',
    to: ['support@helpdock.test'],
    cc: [],
    received_for: ['support@helpdock.test'],
    subject: 'Hello',
    message_id: '<rs-1@example.com>',
    created_at: '2026-09-15T10:00:00.000Z',
    attachments: [
      {
        filename: 'a.png',
        content_type: 'image/png',
        content_id: 'img@x',
        content: Buffer.from('a').toString('base64'),
      },
      { filename: 'meta-only.pdf', content_type: 'application/pdf' },
    ],
  };

  it('accepts a payload that carries the body', async () => {
    const { email, recipients } = await parseInboundPayload(
      'resend',
      json({
        type: 'email.received',
        data: { ...data, html: '<p>Hi</p>', headers: { 'In-Reply-To': '<s@h>' } },
      }),
    );

    expect(email.messageId).toBe('rs-1@example.com');
    expect(email.inReplyTo).toBe('s@h');
    expect(recipients).toEqual(['support@helpdock.test']);
    expect(email.attachments.map((file) => file.filename)).toEqual(['a.png']);
  });

  it('refuses the metadata-only webhook with a reason the provider can log', async () => {
    await expect(
      parseInboundPayload('resend', json({ type: 'email.received', data })),
    ).rejects.toBeInstanceOf(InboundBodyMissingError);
    await expect(parseInboundPayload('resend', json({}))).rejects.toBeInstanceOf(
      InboundPayloadError,
    );
    await expect(parseInboundPayload('resend', form({}))).rejects.toBeInstanceOf(
      InboundPayloadError,
    );
  });
});

describe('generic JSON', () => {
  it('parses a raw message', async () => {
    const { email } = await parseInboundPayload('generic', json({ raw: RAW }));
    expect(email.messageId).toBe('raw-1@example.com');
  });

  it('takes a structured message as given', async () => {
    const { email, recipients } = await parseInboundPayload(
      'generic',
      json({
        from: { address: 'Mona@Example.com', name: 'Mona' },
        to: [{ address: 'support@helpdock.test' }],
        subject: 'Hi',
        text: 'Hello',
        messageId: '<g-1@example.com>',
        references: ['<root@helpdock.test>'],
        headers: { 'Auto-Submitted': 'auto-replied' },
        attachments: [
          {
            filename: 'a.txt',
            contentType: 'text/plain',
            content: Buffer.from('a').toString('base64'),
          },
        ],
      }),
    );

    expect(email.messageId).toBe('g-1@example.com');
    expect(email.references).toEqual(['root@helpdock.test']);
    expect(email.headers.get('auto-submitted')).toEqual(['auto-replied']);
    expect(email.attachments[0]).toMatchObject({ filename: 'a.txt', inline: false });
    expect(recipients).toEqual(['support@helpdock.test']);
  });

  it('refuses a body that matches neither shape', async () => {
    await expect(parseInboundPayload('generic', json({ subject: 'x' }))).rejects.toBeInstanceOf(
      InboundPayloadError,
    );
    await expect(parseInboundPayload('generic', form({}))).rejects.toBeInstanceOf(
      InboundPayloadError,
    );
  });
});
