import { describe, expect, it } from 'vitest';
import { sanitizeCustomCss } from './custom-css.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const OTHER = '0192c3f0-1a2b-7c3d-8e4f-000000000002';
const MEDIA = '0192c3f0-1a2b-7c3d-8e4f-0000000000aa';

const run = (css: string) => sanitizeCustomCss(css, { brandId: BRAND });
const reasons = (css: string) => run(css).removed.map((entry) => entry.reason);

describe('sanitizeCustomCss', () => {
  it('keeps ordinary rules and @media blocks, rewritten one per line', () => {
    const result = run(`
      .hd-header { border-block-end-width: 2px; }
      /* a comment */
      .hd-article h2 { letter-spacing: -0.01em !important }
      @media (max-width: 720px) { .hd-hero { padding-block: 32px; } }
    `);

    expect(result.removed).toEqual([]);
    expect(result.css).toBe(
      [
        '.hd-header { border-block-end-width: 2px; }',
        '.hd-article h2 { letter-spacing: -0.01em !important; }',
        '@media (max-width: 720px) {\n  .hd-hero { padding-block: 32px; }\n}',
      ].join('\n'),
    );
  });

  it('drops @import, with or without a url, and reports it', () => {
    const result = run(
      '@import url("https://fonts.example.com/brand.css");\n@import "x.css";\n.a { color: red; }',
    );

    expect(result.css).toBe('.a { color: red; }');
    expect(result.removed.map((entry) => entry.reason)).toEqual(['import', 'import']);
    expect(result.removed[0]?.rule).toContain('@import url("https://fonts.example.com/brand.css")');
  });

  it('drops every other at-rule, and anything nested in @media', () => {
    expect(
      reasons(
        '@font-face { font-family: X; src: url(x.woff2); } @keyframes spin { to { rotate: 1turn; } }',
      ),
    ).toEqual(['at-rule', 'at-rule']);
    expect(reasons('@media screen { @media print { .a { color: red; } } }')).toEqual(['at-rule']);
  });

  it('allows url() for an inline image and for this brand’s own uploads only', () => {
    const inline = '.a { background: url(data:image/png;base64,iVBORw0KGgo=); }';
    const own = `.b { background-image: url("/api/help-center/brands/${BRAND}/media/${MEDIA}"); }`;
    expect(run(`${inline}\n${own}`).removed).toEqual([]);

    expect(reasons('.c { background: url("https://cdn.other.net/bg.jpg"); }')).toEqual(['url']);
    expect(
      reasons(`.d { background: url(/api/help-center/brands/${OTHER}/media/${MEDIA}); }`),
    ).toEqual(['url']);
    expect(reasons('.e { background: url(data:image/svg+xml;base64,PHN2Zz4=); }')).toEqual(['url']);
    expect(reasons('.f { background: image-set("x.png" 1x); }')).toEqual(['url']);
  });

  it('drops expressions, script urls and bindings', () => {
    expect(reasons('.a { width: expression(alert(1)); }')).toEqual(['expression']);
    expect(reasons('.a { background: javascript:alert(1); }')).toEqual(['expression']);
    expect(reasons('.a { behavior: url(x.htc); -moz-binding: none; }')).toEqual([
      'expression',
      'expression',
    ]);
  });

  it('drops fixed positioning but keeps the other declarations of the rule', () => {
    const result = run('.promo-bar { position: fixed; inset-block-end: 0; }');

    expect(result.css).toBe('.promo-bar { inset-block-end: 0; }');
    expect(result.removed).toEqual([{ rule: '.promo-bar { position: fixed; }', reason: 'fixed' }]);
  });

  it('never keeps an escape, however it is spelled', () => {
    expect(reasons('.a { background: u\\72l(https://evil.test/x.png); }')).toEqual(['escape']);
    expect(reasons('.\\61 { color: red; }')).toEqual(['escape']);
    expect(reasons('@media scr\\65en { .a { color: red; } }')).toEqual(['escape']);
  });

  it('cannot close the style element it is rendered in', () => {
    const result = run(
      '.a { content: "</style><script>alert(1)</script>"; } [x="</style>"] { color: red; }',
    );

    expect(result.css).toBe('');
    expect(result.removed.map((entry) => entry.reason)).toEqual(['malformed', 'malformed']);
  });

  it('drops what it cannot parse instead of passing it through', () => {
    expect(reasons('color: red;')).toEqual(['malformed']);
    expect(reasons('.a { : red; }')).toEqual(['malformed']);
    expect(reasons('.a { .b { color: red; } }')).toEqual(['malformed']);
    expect(run('.a { color: red; ').css).toBe('.a { color: red; }');
    expect(run('.a { color: red; } /* never closed').css).toBe('.a { color: red; }');
  });

  it('trims a long dropped rule for the admin', () => {
    const [removed] = run(`.a { background: url("https://x.test/${'a'.repeat(400)}"); }`).removed;

    expect(removed?.rule.length).toBe(200);
    expect(removed?.rule.endsWith('…')).toBe(true);
  });
});
