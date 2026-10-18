import { hcImportAssetPath, hcMediaPath } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { SanitizeLimitError } from './sanitize.js';
import {
  ARTICLE_MAX_TAGS,
  articleImageSources,
  articleLinkTargets,
  sanitizeArticleHtml,
  sanitizeImportedArticleHtml,
} from './sanitize-article.js';

const BRAND = '0192a000-0000-7000-8000-000000000001';
const OTHER = '0192a000-0000-7000-8000-000000000002';
const MEDIA = '0192a000-0000-7000-8000-00000000000a';
const clean = (html: string): string => sanitizeArticleHtml(html, { brandId: BRAND }).html;

describe('imported article resource rewriting', () => {
  it('removes unavailable source download links without removing their text or unrelated links', () => {
    const html = sanitizeImportedArticleHtml(
      '<a href="https://vendor.test/file?secret=temporary&amp;id=1">Original manual</a><a href="https://example.test/help">Help</a>',
      {
        brandId: BRAND,
        unavailableLinks: new Set(['https://vendor.test/file?secret=temporary&id=1']),
      },
    ).html;
    expect(html).not.toContain('vendor.test');
    expect(html).toContain('Original manual');
    expect(html).toContain('href="https://example.test/help"');
  });
  it('recognizes parsed anchor targets without granting access from escaped code examples', () => {
    const path = hcImportAssetPath(BRAND, MEDIA);
    expect(
      articleLinkTargets(
        `<pre>&lt;a href="${path}"&gt;Example&lt;/a&gt;</pre><a href="${path}">Original file</a><a href="https://vendor.test/a?x=1&amp;y=2">Other</a>`,
      ),
    ).toEqual([path, 'https://vendor.test/a?x=1&y=2']);
  });
  it('rewrites decoded image/file locators through managed paths while retaining article sanitization', () => {
    const image = hcMediaPath(BRAND, MEDIA),
      download = hcImportAssetPath(BRAND, MEDIA);
    const prepared = sanitizeImportedArticleHtml(
      '<p>Original <a href="https://vendor.test/file?x=1&amp;y=2" target="self">Manual</a></p><img src="https://vendor.test/image?x=1&amp;y=2" onerror="unsafe()"><script>unsafe()</script><a href="https://example.test/help">Related site</a>',
      {
        brandId: BRAND,
        images: new Map([['https://vendor.test/image?x=1&y=2', image]]),
        links: new Map([['https://vendor.test/file?x=1&y=2', download]]),
      },
    );
    expect(prepared.html).toContain(`src="${image}"`);
    expect(prepared.html).toContain(`href="${download}"`);
    expect(prepared.html).toContain('href="https://example.test/help"');
    expect(prepared.html).not.toContain('vendor.test');
    expect(prepared.html).not.toContain('unsafe');
    expect(prepared.text).toContain('Manual');
  });

  it.each(['images', 'links'] as const)(
    'rejects a foreign-brand %s mapping rather than treating a prepared locator as authority',
    (kind) => {
      const foreign =
        kind === 'images' ? hcMediaPath(OTHER, MEDIA) : hcImportAssetPath(OTHER, MEDIA);
      expect(() =>
        sanitizeImportedArticleHtml('<p>Source body</p>', {
          brandId: BRAND,
          [kind]: new Map([['https://vendor.test/original', foreign]]),
        }),
      ).toThrow(RangeError);
    },
  );
});

describe('articleImageSources', () => {
  it('decodes attributes before import media authorization and preserves source order', () => {
    expect(
      articleImageSources(
        `<IMG SRC='/api/help-center/brands/${BRAND}/media/${MEDIA}'><img src="https:&#47;&#47;vendor.example/a?x=1&amp;y=2"><img src=https://vendor.example/b><img alt="no source">`,
      ),
    ).toEqual([
      `/api/help-center/brands/${BRAND}/media/${MEDIA}`,
      'https://vendor.example/a?x=1&y=2',
      'https://vendor.example/b',
    ]);
  });

  it('ignores image-like text inside comments and non-content tags', () => {
    expect(
      articleImageSources(
        '<!-- <img src="https://comment.example"> --><script>"<img src=script>"</script><style>"<img src=style>"</style><p>&lt;img src=text&gt;</p>',
      ),
    ).toEqual([]);
  });
});

describe('sanitizeArticleHtml', () => {
  it('keeps what the article editor writes', () => {
    const html = [
      '<h2 id="how-long">How long each method takes</h2>',
      '<p dir="rtl">نص <strong>عريض</strong> and <em>more</em></p>',
      '<table><tbody><tr><th colspan="1" rowspan="1"><p>Method</p></th><td colspan="2" rowspan="1"><p>3–5 days</p></td></tr></tbody></table>',
      '<div data-callout="tip"><p>Count business days.</p></div>',
      '<pre><code class="language-text">Refund reference: RF-1</code></pre>',
      '<ol start="3"><li><p>three</p></li></ol>',
      '<hr />',
    ].join('');

    expect(clean(html)).toBe(html);
  });

  it('keeps an image only when it names this brand’s own media route', () => {
    const own = `/api/help-center/brands/${BRAND}/media/${MEDIA}`;
    const theirs = `/api/help-center/brands/${OTHER}/media/${MEDIA}`;

    expect(clean(`<img src="${own}" alt="Refund email" width="1200" height="640">`)).toBe(
      `<img src="${own}" alt="Refund email" width="1200" height="640" />`,
    );
    expect(clean(`<p>a</p><img src="${theirs}" alt="x">`)).toBe('<p>a</p>');
    expect(clean('<img src="https://tracker.example/pixel.gif">')).toBe('');
    expect(clean(`<img src="data:image/png;base64,AAAA">`)).toBe('');
  });

  it('stores a video as the address of an allowed player, never as an iframe', () => {
    expect(clean('<div data-video="https://youtu.be/dQw4w9WgXcQ"></div>')).toBe(
      '<div data-video="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></div>',
    );
    expect(clean('<iframe src="https://evil.example"></iframe><p>ok</p>')).toBe('<p>ok</p>');
    expect(clean('<div data-video="https://evil.example/x"><p>t</p></div>')).toBe(
      '<div><p>t</p></div>',
    );
  });

  it('drops an anchor id that is not a slug and a direction that means nothing', () => {
    expect(clean('<h2 id="x&quot; onmouseover=&quot;a" dir="sideways">T</h2>')).toBe('<h2>T</h2>');
    expect(clean('<h3 id="Upper Case">T</h3>')).toBe('<h3>T</h3>');
  });

  it('allows fragment and same-host links but not script or protocol-relative ones', () => {
    expect(clean('<a href="#how-long">jump</a>')).toBe(
      '<a href="#how-long" rel="noopener noreferrer">jump</a>',
    );
    expect(clean('<a href="/en/articles/refunds">see</a>')).toBe(
      '<a href="/en/articles/refunds" rel="noopener noreferrer">see</a>',
    );
    expect(clean('<a href="javascript:alert(1)">x</a>')).toBe('<a rel="noopener noreferrer">x</a>');
    expect(clean('<a href="//evil.example">x</a>')).toBe('<a rel="noopener noreferrer">x</a>');
    expect(clean('<a href="https://example.com" target="_top">x</a>')).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>',
    );
  });

  it('drops scripts, styles, handlers and classes other than a code language', () => {
    expect(
      clean(
        '<p class="evil" style="position:fixed" onclick="x()">hi</p><script>alert(1)</script><style>p{}</style>',
      ),
    ).toBe('<p>hi</p>');
    expect(clean('<code class="language-js other">x</code>')).toBe(
      '<code class="language-js">x</code>',
    );
  });

  it('keeps a callout’s kind only when it is one the editor offers', () => {
    expect(clean('<div data-callout="danger" dir="rtl"><p>x</p></div>')).toBe(
      '<div dir="rtl"><p>x</p></div>',
    );
  });

  it('extracts text from the sanitised article', () => {
    expect(
      sanitizeArticleHtml('<h2>Title</h2><p>One</p><script>no</script><p>Two</p>', {
        brandId: BRAND,
      }).text,
    ).toBe('Title\nOne\nTwo');
  });

  it('is idempotent, so re-saving a stored article changes nothing', () => {
    const once = clean(
      '<h2 id="a">A</h2><p dir="auto">b <a href="#a">c</a></p><div data-video="https://vimeo.com/123"></div>',
    );

    expect(clean(once)).toBe(once);
  });

  it('refuses an article built to be expensive', () => {
    expect(() => clean('<b>'.repeat(ARTICLE_MAX_TAGS + 1))).toThrow(SanitizeLimitError);
  });
});
