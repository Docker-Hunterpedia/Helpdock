import { describe, expect, it } from 'vitest';
import { articleUrl, popularSummaries, readingMinutes, summaryOf } from './article-view.js';

const hit = {
  articleId: '0192c3f0-0000-7000-8000-00000000000a',
  slug: 'refund-timelines',
  locale: 'en' as const,
  title: 'Refund timelines',
  sectionTitle: 'Returns & refunds',
};

describe('the widget’s article view', () => {
  it('links an article on the brand’s help center host, per language', () => {
    expect(articleUrl('https://help.example.com', 'ar', 'refund-timelines')).toBe(
      'https://help.example.com/ar/articles/refund-timelines',
    );
    expect(articleUrl(null, 'en', 'refund-timelines')).toBeNull();
  });

  it('shows a search hit with the words around the match', () => {
    expect(summaryOf({ ...hit, snippet: 'Card refunds land in 3–5 days' }, null)).toEqual({
      id: hit.articleId,
      title: 'Refund timelines',
      excerpt: 'Card refunds land in 3–5 days',
      section: 'Returns & refunds',
      url: null,
    });
  });

  it('shows a popular article with its description, and no section when it has no name', () => {
    const [summary] = popularSummaries(
      [{ ...hit, sectionTitle: '', description: 'How long a refund takes' }],
      'https://help.example.com',
    );

    expect(summary).toMatchObject({
      excerpt: 'How long a refund takes',
      section: null,
      url: 'https://help.example.com/en/articles/refund-timelines',
    });
    expect(summaryOf(hit, null).excerpt).toBe('');
  });

  it('reads 200 words a minute, and never less than a minute', () => {
    expect(readingMinutes('')).toBe(1);
    expect(readingMinutes('word '.repeat(200))).toBe(1);
    expect(readingMinutes('word '.repeat(201))).toBe(2);
  });
});
