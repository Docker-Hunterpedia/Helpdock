import { describe, expect, it } from 'vitest';
import { rewriteGuideLinks, rewriteHref } from './links.ts';

const guides = { sourceDir: 'docs/guides', publishedGuides: new Set(['email', 'slas']) };
const blob = 'https://github.com/Docker-Hunterpedia/Helpdock/blob/main';

describe('rewriteHref', () => {
  it('sends a published guide to its page on the site, keeping the anchor', () => {
    expect(rewriteHref('email.md', guides)).toBe('/docs/email/');
    expect(rewriteHref('./slas.md#the-clocks', guides)).toBe('/docs/slas/#the-clocks');
  });

  it('sends an unpublished guide to GitHub', () => {
    expect(rewriteHref('website.md', guides)).toBe(`${blob}/docs/guides/website.md`);
  });

  it('sends every other repository path to GitHub, resolved from the guide', () => {
    expect(rewriteHref('../planning/DOMAIN-RULES.md#3-sla-calculation', guides)).toBe(
      `${blob}/docs/planning/DOMAIN-RULES.md#3-sla-calculation`,
    );
    expect(rewriteHref('../../.env.example', guides)).toBe(`${blob}/.env.example`);
  });

  it('links a folder as a tree', () => {
    expect(rewriteHref('../../deploy/dokploy/', guides)).toBe(
      'https://github.com/Docker-Hunterpedia/Helpdock/tree/main/deploy/dokploy',
    );
  });

  it('resolves links of a file at the repository root', () => {
    const root = { sourceDir: '.', publishedGuides: guides.publishedGuides };
    expect(rewriteHref('docs/guides/email.md#health', root)).toBe('/docs/email/#health');
    expect(rewriteHref('docs/completed/README.md', root)).toBe(`${blob}/docs/completed/README.md`);
  });

  it.each([
    'https://example.com/a.md',
    'mailto:contact@oday-bakkour.com',
    '#known-gaps',
    '/already/a/site/path/',
    '',
  ])('keeps %s as it is', (href) => {
    expect(rewriteHref(href, guides)).toBe(href);
  });

  it('keeps a path that climbs out of the repository', () => {
    expect(rewriteHref('../../../elsewhere.md', guides)).toBe('../../../elsewhere.md');
  });
});

describe('rewriteGuideLinks', () => {
  it('rewrites anchors and images and leaves text that looks like a link alone', () => {
    const html =
      '<p><a href="email.md">Email</a> and <img src="../design/a.png" alt=""> ' +
      'and <code>&lt;a href="email.md"&gt;</code></p>';
    expect(rewriteGuideLinks(html, guides)).toBe(
      `<p><a href="/docs/email/">Email</a> and <img src="${blob}/docs/design/a.png" alt=""> ` +
        'and <code>&lt;a href="email.md"&gt;</code></p>',
    );
  });

  it('keeps an encoded ampersand encoded', () => {
    expect(rewriteGuideLinks('<a href="../x.md?a=1&amp;b=2">x</a>', guides)).toBe(
      `<a href="${blob}/docs/x.md?a=1&amp;b=2">x</a>`,
    );
  });
});
