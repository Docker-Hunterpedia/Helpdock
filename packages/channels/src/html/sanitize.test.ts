import { describe, expect, it } from 'vitest';
import { MAX_TAGS, SanitizeLimitError, sanitizeMessageHtml } from './sanitize.js';

/**
 * REQUIREMENTS §5.1: "no HTML JS/forms rendered; sanitized HTML (allowlist)".
 * Every case below is something that has arrived in a real support inbox.
 */
describe('sanitizeMessageHtml', () => {
  it('keeps the markup a reply is actually written in', () => {
    const html =
      '<p>Hello <strong>there</strong></p><ul><li>one</li></ul><blockquote>quoted</blockquote>';

    expect(sanitizeMessageHtml(html)).toBe(html);
  });

  it('drops a script element and its content rather than unwrapping it', () => {
    expect(sanitizeMessageHtml('<p>hi</p><script>alert(1)</script>')).toBe('<p>hi</p>');
  });

  it('drops a style element, so a stylesheet cannot reposition the page', () => {
    expect(sanitizeMessageHtml('<style>body{display:none}</style><p>hi</p>')).toBe('<p>hi</p>');
  });

  it('refuses a javascript: link', () => {
    expect(sanitizeMessageHtml('<a href="javascript:alert(1)">x</a>')).toBe(
      '<a rel="noopener noreferrer nofollow">x</a>',
    );
  });

  it('refuses a javascript: link hidden behind an entity', () => {
    expect(sanitizeMessageHtml('<a href="java&#115;cript:alert(1)">x</a>')).not.toContain(
      'alert(1)',
    );
  });

  it('refuses a protocol-relative link, which inherits the page scheme', () => {
    expect(sanitizeMessageHtml('<a href="//evil.example/x">x</a>')).toBe(
      '<a rel="noopener noreferrer nofollow">x</a>',
    );
  });

  it('keeps an http link and gives it rel="noopener noreferrer nofollow"', () => {
    expect(sanitizeMessageHtml('<a href="https://example.com">x</a>')).toBe(
      '<a href="https://example.com" rel="noopener noreferrer nofollow">x</a>',
    );
  });

  it('replaces a rel the sender chose rather than trusting it', () => {
    expect(sanitizeMessageHtml('<a href="https://example.com" rel="opener">x</a>')).toContain(
      'rel="noopener noreferrer nofollow"',
    );
  });

  it('drops <svg onload> entirely, element and handler', () => {
    expect(sanitizeMessageHtml('<svg onload="alert(1)"><circle /></svg><p>after</p>')).toBe(
      '<p>after</p>',
    );
  });

  it('drops an event handler from an element it keeps', () => {
    expect(sanitizeMessageHtml('<p onclick="alert(1)">hi</p>')).toBe('<p>hi</p>');
  });

  it('drops onerror from an image it keeps', () => {
    const sanitized = sanitizeMessageHtml('<img src="cid:logo" onerror="alert(1)" />');

    expect(sanitized).toContain('src="cid:logo"');
    expect(sanitized).not.toContain('onerror');
  });

  it('drops a form, its controls and their labels, keeping the prose around them', () => {
    expect(
      sanitizeMessageHtml(
        '<p>before</p><form action="https://evil.example"><input name="pw" /><button>Verify your account</button></form><p>after</p>',
      ),
    ).toBe('<p>before</p><p>after</p>');
  });

  it('keeps prose that a newsletter happened to wrap in a form', () => {
    expect(sanitizeMessageHtml('<form><p>Read this</p></form>')).toBe('<p>Read this</p>');
  });

  it('drops nested forms, which is how a parser is tricked into reopening one', () => {
    expect(sanitizeMessageHtml('<form><form><input name="pw" /></form></form><p>x</p>')).toBe(
      '<p>x</p>',
    );
  });

  it('drops an iframe', () => {
    expect(sanitizeMessageHtml('<iframe src="https://evil.example"></iframe><p>x</p>')).toBe(
      '<p>x</p>',
    );
  });

  it('drops a style attribute, so CSS expression() has nowhere to live', () => {
    expect(
      sanitizeMessageHtml('<p style="width: expression(alert(1)); position: fixed">hi</p>'),
    ).toBe('<p>hi</p>');
  });

  it('drops a class, which would otherwise collide with the admin stylesheet', () => {
    expect(sanitizeMessageHtml('<p class="MuiButton-root">hi</p>')).toBe('<p>hi</p>');
  });

  it('keeps a cid: image, which is how an inline attachment refers to itself', () => {
    expect(sanitizeMessageHtml('<img src="cid:logo@acme" alt="Acme" />')).toBe(
      '<img src="cid:logo@acme" alt="Acme" />',
    );
  });

  it('blocks a remote image by default, because it is a read receipt nobody asked for', () => {
    expect(sanitizeMessageHtml('<img src="https://tracker.example/p.gif" />')).toBe('<img />');
  });

  it('blocks a data: image, which is how a polyglot arrives inline', () => {
    expect(sanitizeMessageHtml('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" />')).toBe(
      '<img />',
    );
  });

  it('keeps a remote image when the caller allows one', () => {
    expect(
      sanitizeMessageHtml('<img src="https://cdn.example/p.png" />', { imageSrc: 'allow-remote' }),
    ).toBe('<img src="https://cdn.example/p.png" />');
  });

  it('still blocks data: when remote images are allowed', () => {
    expect(
      sanitizeMessageHtml('<img src="data:text/html;base64,PHNjcmlwdD4=" />', {
        imageSrc: 'allow-remote',
      }),
    ).toBe('<img />');
  });

  it('drops an HTML comment, which a mail client can act on', () => {
    expect(sanitizeMessageHtml('<!--[if mso]><p>outlook</p><![endif]--><p>x</p>')).not.toContain(
      'outlook',
    );
  });

  it('returns an empty string for an empty body rather than throwing', () => {
    expect(sanitizeMessageHtml('')).toBe('');
  });

  it('parses a half-closed document the way a mail client would', () => {
    expect(sanitizeMessageHtml('<p>one<p>two')).toBe('<p>one</p><p>two</p>');
  });

  it.each([
    ['a root-relative image', '<img src="/pixel.gif" />'],
    ['a document-relative image', '<img src="p.gif" />'],
    ['a parent-relative image', '<img src="../tracking/p.gif" />'],
  ])('drops %s, which would fire from the reader’s own session', (_name, html) => {
    // A scheme allowlist is applied only to a URL that *has* a scheme. A
    // relative one resolves against whatever page renders the message, so under
    // `cid-only` it is still a read receipt — fired by the agent's browser at
    // the admin's own origin.
    expect(sanitizeMessageHtml(html)).toBe('<img />');
  });

  it('drops a relative image even when remote images are allowed', () => {
    expect(sanitizeMessageHtml('<img src="/pixel.gif" />', { imageSrc: 'allow-remote' })).toBe(
      '<img />',
    );
  });

  it('drops a relative link, which would look like a genuine in-app one', () => {
    expect(sanitizeMessageHtml('<a href="/settings/delete">Click here</a>')).toBe(
      '<a rel="noopener noreferrer nofollow">Click here</a>',
    );
  });

  it('refuses a body built to be expensive rather than parsing it', () => {
    // The cost is super-linear in nesting depth, not in size, and sanitising
    // runs synchronously inside the request's open transaction.
    const nested = '<b>'.repeat(MAX_TAGS + 1);

    expect(() => sanitizeMessageHtml(nested)).toThrow(SanitizeLimitError);
  });

  it('accepts a body at the limit, so the ceiling is above any real message', () => {
    expect(() => sanitizeMessageHtml('<b>x</b>'.repeat(MAX_TAGS / 2))).not.toThrow();
  });

  it('counts tags, not bytes: a long plain body is fine', () => {
    expect(() => sanitizeMessageHtml(`<p>${'a'.repeat(199_000)}</p>`)).not.toThrow();
  });

  it('is idempotent: sanitising its own output changes nothing', () => {
    const once = sanitizeMessageHtml(
      '<p onclick="x">hi <a href="https://example.com">link</a></p><script>y</script>',
    );

    expect(sanitizeMessageHtml(once)).toBe(once);
  });
});
