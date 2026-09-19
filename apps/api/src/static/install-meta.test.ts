import { describe, expect, it } from 'vitest';
import { type InstallMeta, rewriteInstallMeta } from './install-meta.js';

const page = (head: string): string => `<!doctype html><html><head>${head}</head></html>`;

const fixture = page(
  '<meta name="helpdock:primary-domain" content="support.helpdock.com" />' +
    '<meta name="helpdock:brand-count" content="3" />' +
    '<meta name="helpdock:install-state" content="configured" />' +
    '<meta name="helpdock:version" content="0.1.0" />',
);

const meta = (overrides: Partial<InstallMeta> = {}): InstallMeta => ({
  primaryDomain: 'help.acme.test',
  brandCount: 1,
  installState: 'configured',
  version: '1.2.3',
  ...overrides,
});

describe('rewriteInstallMeta', () => {
  it('replaces every tag with the values of this install', () => {
    const html = rewriteInstallMeta(fixture, meta({ brandCount: 7, installState: 'fresh' }));

    expect(html).toContain('<meta name="helpdock:primary-domain" content="help.acme.test" />');
    expect(html).toContain('<meta name="helpdock:brand-count" content="7" />');
    expect(html).toContain('<meta name="helpdock:install-state" content="fresh" />');
    expect(html).toContain('<meta name="helpdock:version" content="1.2.3" />');
    expect(html).not.toContain('support.helpdock.com');
  });

  it('leaves the rest of the document alone', () => {
    const html = rewriteInstallMeta(
      page('<title>Helpdock</title><meta name="helpdock:brand-count" content="3" />'),
      meta(),
    );

    expect(html).toContain('<title>Helpdock</title>');
  });

  it('escapes a domain that carries markup, so a row cannot become an element', () => {
    const html = rewriteInstallMeta(
      fixture,
      meta({ primaryDomain: '"><script>alert(1)</script>' }),
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('returns a document with none of the tags unchanged', () => {
    const plain = page('<title>Helpdock</title>');

    // The admin falls back to the host it was served from, to one brand and to
    // a configured install, which is the right answer for a build served from
    // somewhere else.
    expect(rewriteInstallMeta(plain, meta({ brandCount: 4 }))).toBe(plain);
  });

  it('matches the tag however its attributes are spaced', () => {
    const html = rewriteInstallMeta(
      page('<meta    name="helpdock:brand-count"   content="3">'),
      meta({ brandCount: 2 }),
    );

    expect(html).toContain('<meta name="helpdock:brand-count" content="2" />');
  });
});
