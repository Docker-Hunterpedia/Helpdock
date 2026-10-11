import { META_TEXT_LIMITS, metaOpeningLine } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { replyTextParts } from './meta-reply-text.js';

const opening = metaOpeningLine({ firstName: 'Lina', brand: 'Helpdock' });

describe('replyTextParts', () => {
  it('puts the opening line on its own line above the agent’s words', () => {
    expect(
      replyTextParts({ platform: 'whatsapp', openingLine: opening, bodyText: 'It ships today.' }),
    ).toEqual(['Lina · Helpdock\nIt ships today.']);
  });

  it('opens the first message only', () => {
    const bodyText = `${'a'.repeat(1_500)} ${'b'.repeat(1_500)}`;

    const parts = replyTextParts({ platform: 'messenger', openingLine: opening, bodyText });

    expect(parts).toHaveLength(2);
    expect(parts[0]?.startsWith('Lina · Helpdock\n')).toBe(true);
    expect(parts[1]).toBe('b'.repeat(1_500));
    expect(parts.slice(1).some((part) => part.includes('Helpdock'))).toBe(false);
  });

  it('counts the line toward the limit: a text that just fits alone is cut once the line is in front', () => {
    const limit = META_TEXT_LIMITS.messenger.max;
    const bodyText = `${'a'.repeat(limit - 20)} ${'b'.repeat(10)}`;

    // On its own it is one message of 1,991 characters...
    expect(replyTextParts({ platform: 'messenger', openingLine: '', bodyText })).toHaveLength(1);
    // ...with the 16-character line and its newline it is not.
    const parts = replyTextParts({ platform: 'messenger', openingLine: opening, bodyText });
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(limit);
    }
  });

  it('counts the line in bytes on Instagram, and every part stays within 1000 of them', () => {
    const arabic = Array.from({ length: 120 }, () => 'الطلب').join(' ');
    const line = metaOpeningLine({ firstName: 'لينا', brand: 'هيلب دوك' });

    const parts = replyTextParts({ platform: 'instagram', openingLine: line, bodyText: arabic });

    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]?.startsWith(`${line}\n`)).toBe(true);
    for (const part of parts) {
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(1_000);
      expect(part).not.toContain('�');
    }
    expect(parts.slice(1).join(' ')).not.toContain('هيلب');
  });

  it('is the line alone, as a message of its own, for a reply that is only files', () => {
    for (const bodyText of ['', '   \n ']) {
      expect(replyTextParts({ platform: 'instagram', openingLine: opening, bodyText })).toEqual([
        'Lina · Helpdock',
      ]);
    }
  });

  it('is the brand alone for a reply nobody wrote', () => {
    expect(
      replyTextParts({
        platform: 'whatsapp',
        openingLine: metaOpeningLine({ firstName: null, brand: 'Helpdock' }),
        bodyText: 'Can I help?',
      }),
    ).toEqual(['Helpdock\nCan I help?']);
  });
});
