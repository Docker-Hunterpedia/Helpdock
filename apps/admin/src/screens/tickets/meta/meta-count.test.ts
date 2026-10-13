import type { Attachment, MetaPlatform } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { planMetaMessages, replyTextParts } from './meta-count.js';

/**
 * The count under the composer's textarea (M10-08): the text cut by the
 * splitter the send job uses, after the opening line the job puts first, then
 * one message per file.
 */

const LINE = 'Lina · Helpdock';

const file = (overrides: Partial<Attachment> = {}): Attachment => ({
  id: '0192c3f0-1a2b-7c3d-8e4f-0000000000a1',
  ticketId: '0192c3f0-1a2b-7c3d-8e4f-000000001040',
  messageId: null,
  uploaderType: 'staff',
  originalName: 'care-guide.pdf',
  mime: 'application/pdf',
  kind: 'file',
  size: 1_024,
  status: 'ready',
  rejectReason: null,
  scanStatus: 'clean',
  variants: {},
  createdAt: '2026-10-11T09:00:00.000Z',
  processedAt: '2026-10-11T09:00:05.000Z',
  ...overrides,
});

const plan = (
  body: string,
  attachments: readonly Attachment[],
  platform: MetaPlatform = 'whatsapp',
  openingLine = LINE,
) => planMetaMessages({ body, attachments, platform, openingLine });

describe('replyTextParts', () => {
  it('is nothing for no words and no files: there is nothing to send', () => {
    expect(replyTextParts('', 'whatsapp', LINE, false)).toEqual([]);
    expect(replyTextParts('  \n ', 'instagram', LINE, false)).toEqual([]);
  });

  it('opens the first message with the line, a newline, then the words', () => {
    expect(replyTextParts('  The courier comes tomorrow. ', 'messenger', LINE, false)).toEqual([
      `${LINE}\nThe courier comes tomorrow.`,
    ]);
  });

  it('is the line alone, as a message of its own, when the reply is only files', () => {
    expect(replyTextParts('', 'whatsapp', LINE, true)).toEqual([LINE]);
  });

  it('is the words alone while the brand has not been read, and nothing for files alone', () => {
    expect(replyTextParts('Hello', 'whatsapp', '', false)).toEqual(['Hello']);
    expect(replyTextParts('', 'whatsapp', '', true)).toEqual([]);
  });
});

describe('planMetaMessages', () => {
  it('counts one text message for a short reply, and nothing for an empty one', () => {
    expect(plan('Hello', [])).toMatchObject({ textParts: 1, files: 0, total: 1 });
    expect(plan('', [])).toMatchObject({ textParts: 0, files: 0, total: 0 });
  });

  it('counts the opening line toward the limit: it is part of what is cut', () => {
    // 15 characters, a newline, and the words fill WhatsApp's 4096 exactly.
    const fits = 'a'.repeat(4_096 - LINE.length - 1);

    expect(plan(fits, []).textParts).toBe(1);
    expect(plan(`${fits}a`, []).textParts).toBe(2);
    // Without the line the same words are one part, which is how the count was wrong before it.
    expect(plan(`${fits}a`, [], 'whatsapp', '').textParts).toBe(1);
  });

  it('counts Instagram in bytes, the line included: 500 Arabic letters and the line are two parts', () => {
    const letters = 'ب'.repeat(500);

    expect(plan(letters, [], 'instagram', '').textParts).toBe(1);
    expect(plan(letters, [], 'instagram').textParts).toBe(2);
  });

  it('adds one message per file after the text', () => {
    expect(plan('Hello', [file(), file({ id: 'b' })])).toMatchObject({
      textParts: 1,
      files: 2,
      total: 3,
    });
  });

  it('counts the line as the one text message of a reply that is only files', () => {
    expect(plan('', [file()])).toMatchObject({ textParts: 1, files: 1, total: 2 });
  });

  it('leaves out a file the pipeline refused, which the chip already said', () => {
    expect(plan('Hello', [file({ status: 'rejected' })])).toMatchObject({ files: 0, total: 1 });
  });

  describe('a file Instagram will not take', () => {
    const docx = file({
      originalName: 'terms.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    it('is named, and is not one of the messages that go', () => {
      expect(plan('Hello', [file(), docx], 'instagram')).toEqual({
        textParts: 1,
        files: 1,
        total: 2,
        leftOut: [{ name: 'terms.docx', reason: 'pdf-only' }],
      });
    });

    it('is an ordinary attachment on WhatsApp and Messenger, which name no such list', () => {
      for (const platform of ['whatsapp', 'messenger'] as const) {
        expect(plan('Hello', [docx], platform)).toMatchObject({ files: 1, leftOut: [] });
      }
    });

    it('does not name an image: only a document has the PDF-only rule', () => {
      expect(
        plan(
          'Hello',
          [file({ kind: 'image', mime: 'image/webp', originalName: 'a.webp' })],
          'instagram',
        ),
      ).toMatchObject({ files: 1, leftOut: [] });
    });
  });
});
