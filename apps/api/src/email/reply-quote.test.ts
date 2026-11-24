import { describe, expect, it } from 'vitest';
import { buildReplyQuote, capQuoteText, QUOTE_MAX_CHARS } from './reply-quote.js';

const at = new Date('2026-11-10T12:05:00Z');

describe('buildReplyQuote', () => {
  it('writes the English intro and prefixes every text line', () => {
    const quote = buildReplyQuote('en', 'Helpdock', { name: 'Mona Khalil', at, text: 'a\nb' });

    expect(quote.text).toBe('On Tue, 10 Nov 2026 at 12:05 UTC, Mona Khalil wrote:\n> a\n> b');
  });

  it('writes the Arabic intro with Latin digits', () => {
    const quote = buildReplyQuote('ar', 'Helpdock', { name: 'منى خليل', at, text: 'مرحبا' });

    expect(quote.text.split('\n')[0]).toMatch(/^في .*2026.*12:05 UTC.*كتب منى خليل:$/u);
    expect(quote.text).toContain('> مرحبا');
  });

  it('escapes the customer text and name in the HTML part', () => {
    const quote = buildReplyQuote('en', 'Helpdock', {
      name: '<b>Mona</b>',
      at,
      text: '<script>alert(1)</script> & "x"',
    });

    expect(quote.html).not.toContain('<script>');
    expect(quote.html).not.toContain('<b>');
    expect(quote.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;');
    expect(quote.html).toContain('&lt;b&gt;Mona&lt;/b&gt; wrote:');
  });

  it('keeps line breaks as <br> and puts a name with a newline on one line', () => {
    const quote = buildReplyQuote('en', 'Helpdock', {
      name: 'Mona\r\nBcc: x@y.z',
      at,
      text: 'a\nb',
    });

    expect(quote.html).toContain('a<br>b');
    expect(quote.text.split('\n')[0]).toContain('Mona Bcc: x@y.z wrote:');
  });

  it('names the customer when the message has no sender name', () => {
    expect(buildReplyQuote('en', 'H', { name: null, at, text: 'x' }).text).toContain(
      'the customer wrote:',
    );
    expect(buildReplyQuote('ar', 'H', { name: '  ', at, text: 'x' }).text).toContain('العميل');
  });
});

describe('buildReplyQuote, the sender name and the layout', () => {
  it('strips bidirectional format characters from the name', () => {
    const quote = buildReplyQuote('en', 'H', { name: 'Mo\u202Ena\u2066 K', at, text: 'x' });

    expect(quote.text.split('\n')[0]).toBe('On Tue, 10 Nov 2026 at 12:05 UTC, Mona K wrote:');
  });

  it('cuts a long name on code points, never inside a pair', () => {
    const quote = buildReplyQuote('en', 'H', { name: '😀'.repeat(300), at, text: 'x' });
    const name = /UTC, (.*) wrote:/u.exec(quote.text)?.[1] ?? '';

    expect(Array.from(name)).toHaveLength(200);
    expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('draws the rule with a physical property on the side the text starts from', () => {
    const en = buildReplyQuote('en', 'H', { name: 'A', at, text: 'x' }).html;
    const ar = buildReplyQuote('ar', 'H', { name: 'A', at, text: 'x' }).html;

    expect(en).toContain('border-left:3px solid');
    expect(ar).toContain('border-right:3px solid');
    expect(en).toContain('<blockquote dir="auto"');
  });
});

describe('capQuoteText', () => {
  it('leaves text at the cap alone', () => {
    const text = 'a'.repeat(QUOTE_MAX_CHARS);

    expect(capQuoteText(text)).toBe(text);
  });

  it('cuts longer text at the cap and marks the cut', () => {
    const cut = capQuoteText('a'.repeat(QUOTE_MAX_CHARS + 50));

    expect(cut).toBe(`${'a'.repeat(QUOTE_MAX_CHARS)}…`);
  });

  it('does not split a character made of two code units', () => {
    const cut = capQuoteText('😀'.repeat(QUOTE_MAX_CHARS + 1));

    expect(Array.from(cut)).toHaveLength(QUOTE_MAX_CHARS + 1);
    expect(cut.endsWith('😀…')).toBe(true);
  });

  it('normalises line endings and drops control characters', () => {
    expect(capQuoteText('a\r\nb\rc\u0000d')).toBe('a\nb\ncd');
  });
});
