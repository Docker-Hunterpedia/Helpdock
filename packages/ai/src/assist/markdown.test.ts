import { describe, expect, it } from 'vitest';
import { draftMarkdownToHtml } from './markdown.js';

describe('draftMarkdownToHtml', () => {
  it('renders paragraphs, headings, lists and bold', () => {
    expect(
      draftMarkdownToHtml(
        'Duty is **not** charged under €150.\n\n## Who handles clearance\nWe do.\n\n- Keep the receipt\n- Pay VAT on delivery\n\n### Notes\n\nLine one\nline two',
      ),
    ).toBe(
      '<p>Duty is <strong>not</strong> charged under €150.</p>' +
        '<h2>Who handles clearance</h2><p>We do.</p>' +
        '<ul><li>Keep the receipt</li><li>Pay VAT on delivery</li></ul>' +
        '<h3>Notes</h3><p>Line one<br>line two</p>',
    );
  });

  it('escapes everything a model or an agent typed', () => {
    expect(draftMarkdownToHtml('<script>alert(1)</script> & "quotes" \'too\'')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot; &#39;too&#39;</p>',
    );
  });

  it('treats a lone hash and Windows line ends as text', () => {
    expect(draftMarkdownToHtml('# Title\r\n\r\nBody')).toBe('<p># Title</p><p>Body</p>');
  });
});
