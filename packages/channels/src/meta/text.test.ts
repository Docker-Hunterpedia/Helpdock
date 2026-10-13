import {
  META_TEXT_LIMITS,
  type MetaPlatform,
  splitMetaText as splitInSchemas,
} from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  contactsText,
  metaLocationText,
  type StoryLabels,
  splitMetaText,
  storyText,
} from './text.js';

const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

/** The text of every part joined back, ignoring the whitespace a cut drops. */
const squashed = (text: string): string => text.replace(/\s+/g, '');

const ARABIC_WORD = 'مرحبا'; // 5 letters, 10 bytes
const ARABIC_LETTER = 'ب'; // 2 bytes

describe('splitMetaText', () => {
  it('is the schemas package’s splitter, so the admin composer counts what the job sends', () => {
    expect(splitMetaText).toBe(splitInSchemas);
  });

  it.each(['whatsapp', 'messenger', 'instagram'] as const)(
    'returns nothing for an empty reply on %s, so an attachment alone sends no text part',
    (platform) => {
      expect(splitMetaText('', platform)).toEqual([]);
      expect(splitMetaText('  \n\n ', platform)).toEqual([]);
    },
  );

  it('returns a short reply as one part, trimmed', () => {
    expect(splitMetaText('  Thanks for writing in.\n', 'whatsapp')).toEqual([
      'Thanks for writing in.',
    ]);
  });

  describe('WhatsApp: 4096 characters', () => {
    it('keeps a reply of exactly 4096 characters in one part, and cuts at 4097', () => {
      expect(splitMetaText('a'.repeat(4_096), 'whatsapp')).toEqual(['a'.repeat(4_096)]);
      expect(splitMetaText('a'.repeat(4_097), 'whatsapp').map((part) => part.length)).toEqual([
        4_096, 1,
      ]);
    });

    it('cuts a long reply into parts that are never over the limit and lose no letter', () => {
      const text = Array.from({ length: 1_500 }, (_, index) => `word${String(index)}`).join(' ');
      const parts = splitMetaText(text, 'whatsapp');

      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) {
        expect(part.length).toBeLessThanOrEqual(4_096);
      }
      expect(squashed(parts.join(' '))).toBe(squashed(text));
    });
  });

  describe('Messenger: 2000 characters', () => {
    it('keeps 2000 in one part and cuts at 2001', () => {
      expect(splitMetaText('b'.repeat(2_000), 'messenger')).toHaveLength(1);
      expect(splitMetaText('b'.repeat(2_001), 'messenger').map((part) => part.length)).toEqual([
        2_000, 1,
      ]);
    });

    it('counts the Arabic letters as characters, 2000 of them in a part', () => {
      const parts = splitMetaText(ARABIC_LETTER.repeat(2_001), 'messenger');

      expect(parts.map((part) => [...part].length)).toEqual([2_000, 1]);
    });
  });

  describe('Instagram: 1000 bytes', () => {
    it('keeps exactly 1000 bytes of Arabic, which is 500 letters, in one part', () => {
      const text = ARABIC_LETTER.repeat(500);

      expect(bytes(text)).toBe(1_000);
      expect(splitMetaText(text, 'instagram')).toEqual([text]);
    });

    it('cuts 501 Arabic letters into 500 and 1, at a letter and not in the middle of one', () => {
      const parts = splitMetaText(ARABIC_LETTER.repeat(501), 'instagram');

      expect(parts).toEqual([ARABIC_LETTER.repeat(500), ARABIC_LETTER]);
      for (const part of parts) {
        expect(bytes(part)).toBeLessThanOrEqual(1_000);
        // A cut inside a letter would leave U+FFFD behind when the bytes were decoded.
        expect(new TextDecoder().decode(new TextEncoder().encode(part))).toBe(part);
      }
    });

    it('cuts Arabic prose at a space, every part within 1000 bytes and no word broken', () => {
      const text = Array.from({ length: 400 }, () => ARABIC_WORD).join(' ');
      const parts = splitMetaText(text, 'instagram');

      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) {
        expect(bytes(part)).toBeLessThanOrEqual(1_000);
        expect(part.split(' ').every((word) => word === ARABIC_WORD)).toBe(true);
      }
      expect(parts.join(' ')).toBe(text);
    });

    it('counts a three-byte character as three: 333 fit, 334 do not', () => {
      const euro = '€';

      expect(splitMetaText(euro.repeat(333), 'instagram')).toHaveLength(1);
      expect(splitMetaText(euro.repeat(334), 'instagram').map((part) => [...part].length)).toEqual([
        333, 1,
      ]);
    });

    it('counts an emoji as four bytes and never splits its surrogate pair', () => {
      const emoji = '\u{1F600}';
      const parts = splitMetaText(emoji.repeat(251), 'instagram');

      expect(parts.map((part) => [...part].length)).toEqual([250, 1]);
      for (const part of parts) {
        expect(bytes(part)).toBeLessThanOrEqual(1_000);
      }
    });

    it('lets English use all 1000 bytes: a character is a byte there', () => {
      expect(splitMetaText('c'.repeat(1_000), 'instagram')).toHaveLength(1);
      expect(splitMetaText('c'.repeat(1_001), 'instagram')).toHaveLength(2);
    });
  });

  describe('where it cuts', () => {
    const limit = (platform: MetaPlatform): number => META_TEXT_LIMITS[platform].max;

    it('prefers a paragraph break to a line break to a space', () => {
      const first = 'a '.repeat(600).trim(); // 1199 characters
      const second = 'b '.repeat(600).trim();
      const text = `${first}\n\n${second}\n${second}`;
      const parts = splitMetaText(text, 'messenger');

      expect(parts[0]).toBe(first);
      expect(parts.every((part) => part.length <= limit('messenger'))).toBe(true);
    });

    it('cuts at a line break when there is no paragraph break in the second half', () => {
      const line = 'x'.repeat(1_200);
      const text = `${line}\n${line}`;

      expect(splitMetaText(text, 'messenger')).toEqual([line, line]);
    });

    it('does not cut early at a separator in the first half, which would leave a stub', () => {
      const text = `${'a'.repeat(100)} ${'b'.repeat(2_500)}`;
      const parts = splitMetaText(text, 'messenger');

      // The only space is far inside the first half of the first part, so the
      // cut falls where the limit does, in the middle of the long word.
      expect(parts[0]?.length).toBe(2_000);
    });

    it('cuts a word longer than a part where the limit falls, and loses nothing', () => {
      const word = 'z'.repeat(9_000);
      const parts = splitMetaText(word, 'whatsapp');

      expect(parts.map((part) => part.length)).toEqual([4_096, 4_096, 808]);
      expect(parts.join('')).toBe(word);
    });

    it('drops the whitespace at a cut and nothing else', () => {
      const text = `${'a'.repeat(1_990)}   ${'b'.repeat(20)}`;
      const parts = splitMetaText(text, 'messenger');

      expect(parts).toEqual(['a'.repeat(1_990), 'b'.repeat(20)]);
    });
  });
});

describe('metaLocationText', () => {
  it('writes the label, the point, the venue and a map link', () => {
    const text = metaLocationText(
      {
        latitude: 52.52,
        longitude: 13.405,
        name: 'Brandenburg Gate',
        address: 'Pariser Platz',
        url: null,
      },
      'Location',
    );

    expect(text.split('\n')).toEqual([
      'Location: 52.52, 13.405',
      'Brandenburg Gate',
      'Pariser Platz',
      'https://www.openstreetmap.org/?mlat=52.52&mlon=13.405#map=17/52.52/13.405',
    ]);
  });

  it('leaves out a venue that has no name or address', () => {
    expect(
      metaLocationText(
        { latitude: 1, longitude: 2, name: null, address: null, url: null },
        'Location',
      ).split('\n'),
    ).toHaveLength(2);
  });
});

describe('contactsText', () => {
  it('writes each contact’s name after the label, then its company, numbers and addresses', () => {
    expect(
      contactsText(
        [
          {
            name: 'Mona Khalil',
            org: 'Khalil Trading',
            phones: ['+963 931 234 567'],
            emails: ['mona@example.com'],
          },
          { name: 'Omar', org: null, phones: ['+971 50 123 4567'], emails: [] },
        ],
        'Contact',
      ),
    ).toBe(
      [
        'Contact: Mona Khalil',
        'Khalil Trading',
        '+963 931 234 567',
        'mona@example.com',
        '',
        'Contact: Omar',
        '+971 50 123 4567',
      ].join('\n'),
    );
  });

  it('writes the label alone for a contact that has no name', () => {
    expect(
      contactsText([{ name: '', org: null, phones: ['+1 555 0100'], emails: [] }], 'Contact'),
    ).toBe('Contact\n+1 555 0100');
  });
});

describe('storyText', () => {
  const labels: StoryLabels = {
    reply: 'Replied to your story',
    mention: 'Mentioned you in their story',
  };

  it('names the story and links its media when Meta gave a link', () => {
    expect(storyText({ kind: 'reply', id: '1', url: 'https://x.test/s' }, labels)).toBe(
      'Replied to your story\nhttps://x.test/s',
    );
    expect(storyText({ kind: 'mention', id: null, url: 'https://x.test/m' }, labels)).toBe(
      'Mentioned you in their story\nhttps://x.test/m',
    );
  });

  it('says only that there was a story when there is no link', () => {
    expect(storyText({ kind: 'mention', id: null, url: null }, labels)).toBe(
      'Mentioned you in their story',
    );
  });
});
