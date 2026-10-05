import { describe, expect, it } from 'vitest';
import { CHUNK_MAX_TOKENS, chunkDocument, estimateTokens } from './chunker.js';
import { detectLocale } from './locale.js';

const words = (count: number, word = 'refund'): string => Array(count).fill(word).join(' ');

describe('chunkDocument', () => {
  it('opens every chunk with its heading path and never crosses a heading', () => {
    const chunks = chunkDocument({
      title: 'Billing',
      parts: [{ text: '# Billing\n\nIntro.\n\n## Refunds\n\nFive days.\n\n## Exchanges\n\nFree.' }],
    });

    expect(chunks.map((chunk) => chunk.content)).toEqual([
      'Billing\n\nIntro.',
      'Billing › Refunds\n\nFive days.',
      'Billing › Exchanges\n\nFree.',
    ]);
    expect(chunks[1]?.meta).toEqual({ headings: ['Billing', 'Refunds'] });
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2]);
  });

  it('uses the title as the path of text above the first heading', () => {
    const [chunk] = chunkDocument({ title: 'Hours', parts: [{ text: 'Nine to five.' }] });

    expect(chunk?.content).toBe('Hours\n\nNine to five.');
  });

  it('keeps every chunk within the budget and repeats the tail of the previous one', () => {
    const paragraphs = Array.from({ length: 12 }, (_, index) => `Paragraph ${index}. ${words(80)}`);
    const chunks = chunkDocument(
      { title: 'Long', parts: [{ text: paragraphs.join('\n\n') }] },
      { maxTokens: 300, overlapTokens: 100 },
    );

    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(300);
    }
    const overlap = chunks[1]?.content.replace('Long\n\n', '').split('\n\n')[0] ?? '';
    expect(estimateTokens(overlap)).toBeLessThanOrEqual(100);
    expect(overlap).not.toBe('');
    expect(chunks[0]?.content.endsWith(overlap)).toBe(true);
  });

  it('repeats whole paragraphs as the overlap when they fit', () => {
    const chunks = chunkDocument(
      { title: '', parts: [{ text: 'First.\n\nSecond.\n\nThird.\n\nFourth.' }] },
      { maxTokens: 6, overlapTokens: 2 },
    );

    expect(chunks.map((chunk) => chunk.content)).toEqual([
      'First.\n\nSecond.\n\nThird.',
      'Third.\n\nFourth.',
    ]);
  });

  it('repeats only the last words of a unit too long to repeat whole', () => {
    const chunks = chunkDocument(
      { title: '', parts: [{ text: ['First.', 'Second.', words(20), 'Fourth.'].join('\n\n') }] },
      { maxTokens: 30, overlapTokens: 5 },
    );

    expect(chunks.map((chunk) => chunk.content)).toEqual([
      'First.\n\nSecond.',
      words(15),
      `${words(2)}\n\n${words(5)}\n\nFourth.`,
    ]);
  });

  it('cuts a paragraph longer than a chunk at sentences, then at words', () => {
    const sentence = `${words(300)}.`;
    const chunks = chunkDocument({ title: '', parts: [{ text: `${sentence} ${sentence}` }] });

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
    }
  });

  it('carries a part’s meta, such as a PDF page, into its chunks', () => {
    const chunks = chunkDocument({
      title: 'FAQ',
      parts: [
        { text: 'One.', meta: { page: 1 } },
        { text: 'Two.', meta: { page: 2 } },
      ],
    });

    expect(chunks.map((chunk) => chunk.meta.page)).toEqual([1, 2]);
  });

  it('labels each chunk with its own language and a stable hash', () => {
    const chunks = chunkDocument({
      title: '',
      parts: [{ text: '# Refunds\n\nFive days.\n\n# الاسترداد\n\nخمسة أيام عمل.' }],
    });

    expect(chunks.map((chunk) => chunk.locale)).toEqual(['en', 'ar']);
    expect(chunkDocument({ title: '', parts: [{ text: '# Refunds\n\nFive days.' }] })[0]).toEqual(
      chunks[0],
    );
  });

  it('skips empty sections', () => {
    expect(chunkDocument({ title: 'x', parts: [{ text: '# Empty\n\n\n# Also empty' }] })).toEqual(
      [],
    );
  });
});

describe('estimateTokens', () => {
  it('counts a token per four characters of each word, at least one', () => {
    expect(estimateTokens('a refund policy')).toBe(1 + 2 + 2);
    expect(estimateTokens('  ')).toBe(0);
  });
});

describe('detectLocale', () => {
  it('files Arabic text with Latin product names as Arabic', () => {
    expect(detectLocale('يمكنك استرداد المبلغ من صفحة Billing خلال 30 يومًا')).toBe('ar');
  });

  it('files English, and text without letters, as English', () => {
    expect(detectLocale('Refunds take five days')).toBe('en');
    expect(detectLocale('12345')).toBe('en');
  });
});
