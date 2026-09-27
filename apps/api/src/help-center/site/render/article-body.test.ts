import { describe, expect, it } from 'vitest';
import { articleBodyHtml } from './article-body.js';
import { formatDate, formatDateTime, readingMinutes } from './text.js';

const render = (html: string) =>
  articleBodyHtml(html, { videoTitle: 'Video', href: (path) => `/hc/b${path}` });

describe('articleBodyHtml', () => {
  it('builds a sandboxed, lazy iframe from a stored video address', () => {
    const html = render('<div data-video="https://player.vimeo.com/video/76979871"></div>');

    expect(html).toBe(
      '<div class="hd-video"><iframe src="https://player.vimeo.com/video/76979871" title="Video" loading="lazy" allow="fullscreen; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"></iframe></div>',
    );
  });

  it('drops a video whose address is not one of the two players', () => {
    expect(render('<p>a</p><div data-video="https://evil.test/embed"></div>')).toBe('<p>a</p>');
  });

  it('rebases links between articles and leaves the rest alone', () => {
    expect(
      render(
        '<a href="/en/articles/x?a=1&amp;b=2">x</a><a href="https://acme.test">y</a><a href="#top">z</a>',
      ),
    ).toBe(
      '<a href="/hc/b/en/articles/x?a=1&amp;b=2">x</a><a href="https://acme.test">y</a><a href="#top">z</a>',
    );
  });
});

describe('text helpers', () => {
  const date = new Date('2026-09-02T22:30:00Z');

  it('writes a date day first in the brand’s zone, with Latin digits in Arabic', () => {
    expect(formatDate(date, 'en', 'Asia/Riyadh')).toBe('3 Sep 2026');
    expect(formatDate(date, 'en', 'UTC')).toBe('2 Sep 2026');
    expect(formatDate(date, 'ar', 'Asia/Riyadh')).toBe('3 سبتمبر 2026');
    expect(formatDate(date, 'en', 'Not/AZone')).toBe('2 Sep 2026');
  });

  it('adds the time and the zone for a scheduled publish', () => {
    expect(formatDateTime(date, 'en', 'Asia/Riyadh')).toBe('3 Sep 2026 01:30 (Asia/Riyadh)');
  });

  it('reads at two hundred words a minute, one at least', () => {
    expect(readingMinutes('<p>one two</p>')).toBe(1);
    expect(readingMinutes(`<p>${'word '.repeat(401)}</p>`)).toBe(3);
  });
});
