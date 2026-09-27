import { describe, expect, it } from 'vitest';
import { sanitizeArticle } from './sanitize.js';

const clean = (html: string) => {
  const host = document.createElement('div');
  host.append(sanitizeArticle(html, document));
  return host.innerHTML;
};

describe('sanitizeArticle', () => {
  it('keeps the article markup the allow-list names', () => {
    expect(clean('<h2>Title</h2><p>Hi <strong>there</strong></p><ul><li>One</li></ul>')).toBe(
      '<h2>Title</h2><p>Hi <strong>there</strong></p><ul><li>One</li></ul>',
    );
  });

  it('drops scripts, styles and frames with their content', () => {
    expect(clean('<p>ok</p><script>alert(1)</script><style>p{}</style><iframe></iframe>')).toBe(
      '<p>ok</p>',
    );
  });

  it('strips every attribute, handlers included, and unwraps unknown elements', () => {
    expect(clean('<p onclick="x()" class="c"><img onerror="y()">text<span>inner</span></p>')).toBe(
      '<p>textinner</p>',
    );
  });

  it('keeps http(s) and mailto links, opening them in a new tab, and neuters the rest', () => {
    expect(clean('<a href="https://help.example.com/a">A</a>')).toBe(
      '<a href="https://help.example.com/a" target="_blank" rel="noopener noreferrer">A</a>',
    );
    expect(clean('<a href="javascript:alert(1)">B</a>')).toBe('<a>B</a>');
  });
});
