import { describe, expect, it } from 'vitest';
import { fileLeftOutText, metaInboundLabels, metaSystemLine, metaText } from './meta-text.js';

describe('the Meta thread wording', () => {
  it('answers in the locale asked for, not with the key', () => {
    const en = metaText('en')('thread.location');
    const ar = metaText('ar')('thread.location');

    expect(en).toBe('Location');
    expect(ar).not.toBe('thread.location');
    expect(ar).not.toBe(en);
  });

  it('gives the adapters the words a message is filed with, in the contact’s language', () => {
    expect(metaInboundLabels('en')).toEqual({
      location: 'Location',
      contact: 'Contact',
      story: { reply: 'Replied to your story', mention: 'Mentioned you in their story' },
    });
    const ar = metaInboundLabels('ar');
    expect(Object.values(ar.story)).not.toContain('thread.story.reply');
    expect(ar.location).not.toBe('Location');
  });

  it.each(['en', 'ar'] as const)('words every system line in %s', (locale) => {
    const lines = [
      metaSystemLine(locale, { kind: 'unsupported' }),
      metaSystemLine(locale, { kind: 'unsent' }),
      metaSystemLine(locale, { kind: 'reaction', emoji: '\u{1F44D}' }),
      metaSystemLine(locale, { kind: 'reaction', emoji: null }),
      metaSystemLine(locale, { kind: 'reactionPlain' }),
      metaSystemLine(locale, { kind: 'edited', text: 'Order 77' }),
      metaSystemLine(locale, { kind: 'numberChanged', from: '+16505551234', to: '+16505559876' }),
    ];

    expect(new Set(lines).size).toBe(lines.length);
    for (const line of lines) {
      expect(line).not.toMatch(/^thread\./);
      expect(line).not.toContain('{{');
    }
  });

  it('puts the words of an edit into the line as they were typed', () => {
    expect(metaSystemLine('en', { kind: 'edited', text: 'Order 77 <b>late</b>' })).toBe(
      'The customer edited a message. It now reads: Order 77 <b>late</b>',
    );
  });

  it('puts the emoji of a reaction and both numbers of a change into the line, unescaped', () => {
    expect(metaSystemLine('en', { kind: 'reaction', emoji: '\u{1F44D}' })).toContain('\u{1F44D}');
    const changed = metaSystemLine('en', {
      kind: 'numberChanged',
      from: '+16505551234',
      to: '+16505559876',
    });
    expect(changed).toContain('+16505551234');
    expect(changed).toContain('+16505559876');
  });
});

const isolated = (name: string): string => `⁨${name}⁩`;

describe('fileLeftOutText', () => {
  it('says Instagram takes PDF files only, naming the file, in English', () => {
    expect(
      fileLeftOutText({
        locale: 'en',
        platform: 'instagram',
        name: 'warranty-terms.docx',
        reason: 'unsupported-type',
        isFile: true,
      }),
    ).toBe(
      `One file could not be sent here: ${isolated('warranty-terms.docx')}. Instagram only takes PDF files, so we will send it another way.`,
    );
  });

  it('says it in Arabic, with the platform in Arabic and the name isolated', () => {
    const text = fileLeftOutText({
      locale: 'ar',
      platform: 'instagram',
      name: 'warranty-terms.docx',
      reason: 'unsupported-type',
      isFile: true,
    });

    expect(text).toContain(isolated('warranty-terms.docx'));
    expect(text).toContain('إنستغرام');
    expect(text).toContain('PDF');
  });

  it('does not blame the file list for an image or a clip the platform does not list', () => {
    const text = fileLeftOutText({
      locale: 'en',
      platform: 'instagram',
      name: 'label.webp',
      reason: 'unsupported-type',
      isFile: false,
    });

    expect(text).toBe(
      `One file could not be sent here: ${isolated('label.webp')}. Instagram does not take this kind of file, so we will send it another way.`,
    );
  });

  it('does not say PDF for a platform whose files are not limited to it', () => {
    const text = fileLeftOutText({
      locale: 'en',
      platform: 'whatsapp',
      name: 'notes.bin',
      reason: 'unsupported-type',
      isFile: true,
    });

    expect(text).not.toContain('PDF');
  });

  it('says it is the size when it is', () => {
    expect(
      fileLeftOutText({
        locale: 'en',
        platform: 'whatsapp',
        name: 'recording.zip',
        reason: 'too-large',
        isFile: true,
      }),
    ).toBe(
      `One file could not be sent here: ${isolated('recording.zip')}. It is larger than WhatsApp allows, so we will send it another way.`,
    );
  });
});
