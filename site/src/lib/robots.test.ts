import { describe, expect, it } from 'vitest';
import { INDEX_ROBOTS, robotsTxt } from './robots.ts';

const groups = (text: string) =>
  text
    .trim()
    .split(/\n\n/)
    .map((group) => group.split('\n'));

describe('robotsTxt', () => {
  const text = robotsTxt('https://helpdock.oday-bakkour.com');

  it('lets every other crawler, AI agents included, read everything', () => {
    expect(groups(text)[0]).toEqual(['User-agent: *', 'Allow: /']);
    expect(text).not.toMatch(/User-agent: \*\nDisallow/);
  });

  it.each(['Googlebot', 'Bingbot'])('keeps %s off the Markdown duplicates', (agent) => {
    const group = groups(text).find((lines) => lines[0] === `User-agent: ${agent}`);
    expect(group).toEqual([
      `User-agent: ${agent}`,
      'Disallow: /*.md$',
      'Disallow: /llms-full.txt',
      'Allow: /',
    ]);
  });

  it('points at the sitemap index', () => {
    expect(text.trim().split('\n').at(-1)).toBe(
      'Sitemap: https://helpdock.oday-bakkour.com/sitemap-index.xml',
    );
  });
});

describe('INDEX_ROBOTS', () => {
  it('asks for indexing with large previews and full snippets', () => {
    expect(INDEX_ROBOTS).toBe(
      'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
    );
  });
});
