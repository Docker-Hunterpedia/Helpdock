import type { AssistCitation } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { insertableReply, redactionParts, textLocale } from './format.js';

const citation = (
  marker: number,
  visibility: 'public' | 'internal',
  url: string | null,
): AssistCitation => ({
  marker,
  title: visibility === 'public' ? 'Refund timelines' : 'Ops handbook.pdf',
  sourceKind: visibility === 'public' ? 'article' : 'file',
  visibility,
  url,
  articleId: null,
  page: null,
});

const suggestion = {
  text: 'Refunds take five days [1]. Big ones need a sign-off [2]. Both apply [1, 2].',
  citations: [
    citation(1, 'public', 'https://help.example.com/refunds'),
    citation(2, 'internal', null),
  ],
};

describe('insertableReply', () => {
  it('strips internal citations from a public reply and lists the public sources', () => {
    expect(insertableReply(suggestion, 'reply')).toBe(
      'Refunds take five days [1]. Big ones need a sign-off. Both apply [1].\n\n[1] Refund timelines: https://help.example.com/refunds',
    );
  });

  it('keeps everything in a note, which no customer reads', () => {
    expect(insertableReply(suggestion, 'note')).toBe(suggestion.text);
  });

  it('adds no sources line when no public source has a link', () => {
    expect(
      insertableReply(
        { text: 'Signed off [1].', citations: [citation(1, 'internal', null)] },
        'reply',
      ),
    ).toBe('Signed off.');
  });
});

describe('textLocale', () => {
  it('reads a message as Arabic when enough of its letters are', () => {
    expect(textLocale('أين استردادي؟ order 7720')).toBe('ar');
    expect(textLocale('Where is my refund? شكرا')).toBe('en');
    expect(textLocale('12345')).toBe('en');
  });
});

describe('redactionParts', () => {
  it('splits placeholders out of a redacted text', () => {
    expect(redactionParts('Call [PHONE_1] or [EMAIL_1].')).toEqual([
      { text: 'Call ', placeholder: false },
      { text: '[PHONE_1]', placeholder: true },
      { text: ' or ', placeholder: false },
      { text: '[EMAIL_1]', placeholder: true },
      { text: '.', placeholder: false },
    ]);
  });
});
