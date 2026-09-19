import { describe, expect, it } from 'vitest';
import { htmlToText, sanitizeMessageBody } from './text.js';

describe('htmlToText', () => {
  it('turns block elements into lines', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\ntwo');
  });

  it('turns <br> into a line break', () => {
    expect(htmlToText('<p>one<br />two</p>')).toBe('one\ntwo');
  });

  it('keeps list items on their own lines', () => {
    expect(htmlToText('<ul><li>one</li><li>two</li></ul>')).toBe('one\ntwo');
  });

  it('keeps the text of inline elements in the same line', () => {
    expect(htmlToText('<p>a <strong>bold</strong> word</p>')).toBe('a bold word');
  });

  it('decodes the entities the sanitiser escapes', () => {
    expect(htmlToText('<p>Tom &amp; Jerry &lt;tom@example.com&gt;</p>')).toBe(
      'Tom & Jerry <tom@example.com>',
    );
  });

  it('does not double-decode: a message that says &lt; keeps saying it', () => {
    expect(htmlToText('<p>write &amp;lt; for a less-than</p>')).toBe('write &lt; for a less-than');
  });

  it('drops script content rather than reading it out as text', () => {
    expect(htmlToText('<p>hi</p><script>alert(1)</script>')).toBe('hi');
  });

  it('drops style content rather than reading CSS out as text', () => {
    expect(htmlToText('<style>body{color:red}</style><p>hi</p>')).toBe('hi');
  });

  it('collapses runs of whitespace, including non-breaking spaces', () => {
    expect(htmlToText('<p>a   b&nbsp;&nbsp;c</p>')).toBe('a b c');
  });

  it('collapses the blank lines email quoting leaves behind', () => {
    expect(htmlToText('<p>a</p><p></p><p></p><p></p><p>b</p>')).toBe('a\n\nb');
  });

  it('is empty for a body that is only markup', () => {
    expect(htmlToText('<p></p><br /><hr />')).toBe('');
  });
});

describe('sanitizeMessageBody', () => {
  it('returns the sanitised html and the text of that same html', () => {
    expect(sanitizeMessageBody('<p onclick="alert(1)">hi <script>alert(2)</script></p>')).toEqual({
      html: '<p>hi </p>',
      text: 'hi',
    });
  });

  it('never derives text from markup the sanitiser removed', () => {
    const { text } = sanitizeMessageBody('<p>visible</p><script>secret</script>');

    expect(text).toBe('visible');
  });

  it('passes the image policy through', () => {
    const { html } = sanitizeMessageBody('<img src="https://cdn.example/p.png" />', {
      imageSrc: 'allow-remote',
    });

    expect(html).toContain('https://cdn.example/p.png');
  });
});
