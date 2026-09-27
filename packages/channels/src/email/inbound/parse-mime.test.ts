import { describe, expect, it } from 'vitest';
import {
  headerMap,
  MAX_RAW_MESSAGE_BYTES,
  parseRawEmail,
  RawMessageTooLargeError,
} from './parse-mime.js';

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const raw = [
  'From: "Mona Khalil" <Mona@Example.com>',
  'To: Support <support@helpdock.test>, "Group, with comma" <two@helpdock.test>',
  'Cc: karim@example.com',
  'Subject: Re: [HD-1042] Refund',
  'Date: Tue, 15 Sep 2026 10:00:00 +0000',
  'Message-ID: <reply-1@example.com>',
  'In-Reply-To: <sent-1@helpdock.test>',
  'References: <root@helpdock.test>\r\n <sent-1@helpdock.test>',
  'Auto-Submitted: no',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="mixed"',
  '',
  '--mixed',
  'Content-Type: multipart/related; boundary="related"',
  '',
  '--related',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>See <img src="cid:shot@x"></p>',
  '--related',
  'Content-Type: image/png; name="shot.png"',
  'Content-ID: <shot@x>',
  'Content-Disposition: inline; filename="shot.png"',
  'Content-Transfer-Encoding: base64',
  '',
  PIXEL.toString('base64'),
  '--related--',
  '--mixed',
  'Content-Type: application/pdf; name="statement.pdf"',
  'Content-Disposition: attachment; filename="statement.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4 test').toString('base64'),
  '--mixed--',
  '',
].join('\r\n');

describe('parseRawEmail', () => {
  it('reads the addresses, ids, subject and date', async () => {
    const email = await parseRawEmail(raw);

    expect(email.from).toEqual({ address: 'mona@example.com', name: 'Mona Khalil' });
    expect(email.to.map((to) => to.address)).toEqual([
      'support@helpdock.test',
      'two@helpdock.test',
    ]);
    expect(email.cc).toEqual([{ address: 'karim@example.com', name: null }]);
    expect(email.messageId).toBe('reply-1@example.com');
    expect(email.inReplyTo).toBe('sent-1@helpdock.test');
    expect(email.references).toEqual(['root@helpdock.test', 'sent-1@helpdock.test']);
    expect(email.subject).toBe('Re: [HD-1042] Refund');
    expect(email.date?.toISOString()).toBe('2026-09-15T10:00:00.000Z');
    expect(email.headers.get('auto-submitted')).toEqual(['no']);
  });

  it('keeps the cid: link and marks the related image inline, the PDF not', async () => {
    const email = await parseRawEmail(Buffer.from(raw));

    expect(email.html).toContain('cid:shot@x');
    const [image, pdf] = email.attachments;
    expect(image).toMatchObject({ filename: 'shot.png', contentId: 'shot@x', inline: true });
    expect(image?.content.equals(PIXEL)).toBe(true);
    expect(pdf).toMatchObject({ filename: 'statement.pdf', contentId: null, inline: false });
  });

  it('synthesises a Message-ID for a message without one', async () => {
    const email = await parseRawEmail('From: a@example.com\r\nSubject: x\r\n\r\nbody\r\n');

    expect(email.messageId).toMatch(/@missing-message-id\.invalid$/);
    expect(email.html).toBeNull();
    expect(email.text?.trim()).toBe('body');
    expect(email.inReplyTo).toBeNull();
    expect(email.references).toEqual([]);
  });

  it('refuses a message over the size cap before parsing it', async () => {
    const huge = Buffer.alloc(MAX_RAW_MESSAGE_BYTES + 1);
    await expect(parseRawEmail(huge)).rejects.toBeInstanceOf(RawMessageTooLargeError);
  });
});

describe('headerMap', () => {
  it('unfolds continuation lines and keeps every value of a repeated header', () => {
    const headers = headerMap([
      { key: 'received', line: 'Received: from a\r\n\tby b' },
      { key: 'Received', line: 'Received: from c' },
      { key: 'x-empty', line: 'X-Empty' },
    ]);

    expect(headers.get('received')).toEqual(['from a by b', 'from c']);
    expect(headers.get('x-empty')).toEqual(['']);
  });
});
