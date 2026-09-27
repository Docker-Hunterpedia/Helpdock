import { describe, expect, it } from 'vitest';
import { plainTextToHtml, SUBJECT_MAX, subjectFrom } from './plain-text.js';

describe('plainTextToHtml', () => {
  it('escapes what a visitor typed and keeps their paragraphs and lines', () => {
    expect(plainTextToHtml('Hi <b>there</b>\nline two\n\nsecond & last')).toBe(
      '<p>Hi &lt;b&gt;there&lt;/b&gt;<br>line two</p><p>second &amp; last</p>',
    );
  });
});

describe('subjectFrom', () => {
  it('is the first line, cut at a word near the limit', () => {
    expect(subjectFrom('  Where is my order?\nIt was due Monday', 'en')).toBe('Where is my order?');

    const long = `${'word '.repeat(30)}end`;
    const subject = subjectFrom(long, 'en');
    expect(subject.length).toBeLessThanOrEqual(SUBJECT_MAX + 1);
    expect(subject.endsWith('word…')).toBe(true);
  });

  it('falls back to the brand language’s "Chat conversation"', () => {
    expect(subjectFrom('   ', 'en')).toBe('Chat conversation');
    expect(subjectFrom('', 'ar')).toBe('محادثة دردشة');
  });

  it('cuts a line with no space where the limit falls', () => {
    expect(subjectFrom('x'.repeat(200), 'en')).toBe(`${'x'.repeat(SUBJECT_MAX)}…`);
  });
});
