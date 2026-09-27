import { describe, expect, it } from 'vitest';
import {
  HC_MEDIA_PATH_PATTERN,
  hcArticleChangedPayloadSchema,
  hcMediaPath,
  hcNamesSchema,
  hcReorderRequestSchema,
  hcSlugSchema,
  hcVersionStatusRequestSchema,
  slugify,
  videoEmbedUrl,
} from './help-center.js';

const ID = '0192a000-0000-7000-8000-000000000001';

describe('hcSlugSchema', () => {
  it('takes lower-case words joined by single hyphens, lower-casing on the way in', () => {
    expect(hcSlugSchema.parse(' Refund-Timelines ')).toBe('refund-timelines');
  });

  it.each(['', 'two--hyphens', '-leading', 'trailing-', 'spaces here', 'مواعيد', 'a/b'])(
    'refuses %j',
    (slug) => {
      expect(hcSlugSchema.safeParse(slug).success).toBe(false);
    },
  );
});

describe('slugify', () => {
  it('turns a title into a slug', () => {
    expect(slugify('Refunds: to a Closed Card!', 'x')).toBe('refunds-to-a-closed-card');
    expect(slugify('Café déjà vu', 'x')).toBe('cafe-deja-vu');
  });

  it('falls back when the title has no ASCII letters or digits', () => {
    expect(slugify('مواعيد استرداد المبالغ', 'article-1')).toBe('article-1');
  });

  it('never ends on a hyphen after cutting to length', () => {
    const slug = slugify(`${'a'.repeat(119)} b`, 'x');

    expect(slug.endsWith('-')).toBe(false);
    expect(hcSlugSchema.safeParse(slug).success).toBe(true);
  });
});

describe('hcNamesSchema', () => {
  it('needs a name in at least one language', () => {
    expect(hcNamesSchema.safeParse({ en: 'Orders', ar: '' }).success).toBe(true);
    expect(hcNamesSchema.safeParse({ en: ' ', ar: '' }).success).toBe(false);
  });
});

describe('hcVersionStatusRequestSchema', () => {
  it('needs a time only when scheduling', () => {
    expect(hcVersionStatusRequestSchema.safeParse({ status: 'published' }).success).toBe(true);
    expect(hcVersionStatusRequestSchema.safeParse({ status: 'scheduled' }).success).toBe(false);
    expect(
      hcVersionStatusRequestSchema.safeParse({
        status: 'scheduled',
        scheduledAt: '2026-10-01T09:00:00+03:00',
      }).success,
    ).toBe(true);
  });
});

describe('hcReorderRequestSchema', () => {
  it('takes a parent, or none for the categories', () => {
    expect(hcReorderRequestSchema.safeParse({ parentId: null, ids: [ID] }).success).toBe(true);
    expect(hcReorderRequestSchema.safeParse({ parentId: null, ids: [] }).success).toBe(false);
  });
});

describe('hcArticleChangedPayloadSchema', () => {
  it('names the article, the language when there is one, and what changed', () => {
    expect(
      hcArticleChangedPayloadSchema.safeParse({ articleId: ID, locale: null, change: 'slug' })
        .success,
    ).toBe(true);
    expect(
      hcArticleChangedPayloadSchema.safeParse({ articleId: ID, locale: 'fr', change: 'slug' })
        .success,
    ).toBe(false);
  });
});

describe('hcMediaPath', () => {
  it('is the one image source the sanitiser keeps', () => {
    expect(HC_MEDIA_PATH_PATTERN.test(hcMediaPath(ID, ID))).toBe(true);
    expect(HC_MEDIA_PATH_PATTERN.test(`https://evil.example${hcMediaPath(ID, ID)}`)).toBe(false);
  });
});

describe('videoEmbedUrl', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('embeds %s through the no-cookie host', (input, id) => {
    expect(videoEmbedUrl(input)).toBe(`https://www.youtube-nocookie.com/embed/${id}`);
  });

  it('embeds Vimeo through its player', () => {
    expect(videoEmbedUrl('https://vimeo.com/76979871')).toBe(
      'https://player.vimeo.com/video/76979871',
    );
    expect(videoEmbedUrl('https://player.vimeo.com/video/76979871')).toBe(
      'https://player.vimeo.com/video/76979871',
    );
  });

  it.each([
    'not a url',
    'javascript:alert(1)',
    'https://evil.example/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/channel/x',
    'https://vimeo.com/abc',
    'https://player.vimeo.com/other/1',
    'ftp://youtu.be/dQw4w9WgXcQ',
  ])('refuses %s', (input) => {
    expect(videoEmbedUrl(input)).toBeNull();
  });
});
