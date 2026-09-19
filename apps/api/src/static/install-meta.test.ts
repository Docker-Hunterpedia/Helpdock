import { describe, expect, it } from 'vitest';
import { rewriteInstallMeta } from './install-meta.js';

const page = (head: string): string => `<!doctype html><html><head>${head}</head></html>`;

const fixture = page(
  '<meta name="helpdock:primary-domain" content="support.helpdock.com" />' +
    '<meta name="helpdock:brand-count" content="3" />',
);

describe('rewriteInstallMeta', () => {
  it('replaces both tags with the values of this install', () => {
    const html = rewriteInstallMeta(fixture, { primaryDomain: 'help.acme.test', brandCount: 7 });

    expect(html).toContain('<meta name="helpdock:primary-domain" content="help.acme.test" />');
    expect(html).toContain('<meta name="helpdock:brand-count" content="7" />');
    expect(html).not.toContain('support.helpdock.com');
  });

  it('leaves the rest of the document alone', () => {
    const html = rewriteInstallMeta(
      page('<title>Helpdock</title><meta name="helpdock:brand-count" content="3" />'),
      { primaryDomain: 'help.acme.test', brandCount: 1 },
    );

    expect(html).toContain('<title>Helpdock</title>');
  });

  it('escapes a domain that carries markup, so a row cannot become an element', () => {
    const html = rewriteInstallMeta(fixture, {
      primaryDomain: '"><script>alert(1)</script>',
      brandCount: 1,
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('returns a document with neither tag unchanged', () => {
    const plain = page('<title>Helpdock</title>');

    // The admin falls back to the host it was served from and to one brand,
    // which is the right answer for a build served from somewhere else.
    expect(rewriteInstallMeta(plain, { primaryDomain: 'help.acme.test', brandCount: 4 })).toBe(
      plain,
    );
  });

  it('matches the tag however its attributes are spaced', () => {
    const html = rewriteInstallMeta(page('<meta    name="helpdock:brand-count"   content="3">'), {
      primaryDomain: 'help.acme.test',
      brandCount: 2,
    });

    expect(html).toContain('<meta name="helpdock:brand-count" content="2" />');
  });
});
