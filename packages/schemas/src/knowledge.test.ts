import { describe, expect, it } from 'vitest';
import {
  knowledgeFilePresignSchema,
  knowledgeLogQuerySchema,
  knowledgeSourceCreateSchema,
  knowledgeSourceUpdateSchema,
} from './knowledge.js';

describe('knowledgeSourceCreateSchema', () => {
  it('defaults a crawl to internal, daily and a hundred pages', () => {
    expect(
      knowledgeSourceCreateSchema.parse({
        kind: 'crawl',
        config: { mode: 'sitemap', url: 'https://docs.example.com/sitemap.xml' },
      }),
    ).toEqual({
      kind: 'crawl',
      visibility: 'internal',
      schedule: 'daily',
      config: {
        mode: 'sitemap',
        url: 'https://docs.example.com/sitemap.xml',
        maxPages: 100,
        include: [],
        exclude: [],
        render: false,
      },
    });
  });

  it('refuses a crawl of anything but http and https, or over the page cap', () => {
    const crawl = (config: object) =>
      knowledgeSourceCreateSchema.safeParse({ kind: 'crawl', config: { mode: 'seed', ...config } })
        .success;

    expect(crawl({ url: 'file:///etc/passwd' })).toBe(false);
    expect(crawl({ url: 'https://x.test', maxPages: 5_001 })).toBe(false);
    expect(crawl({ url: 'https://x.test', maxPages: 5_000 })).toBe(true);
  });

  it('defaults Notion and Drive to nothing picked yet', () => {
    expect(knowledgeSourceCreateSchema.parse({ kind: 'notion', name: 'Playbook' })).toMatchObject({
      visibility: 'internal',
      config: { pageIds: [], databaseIds: [] },
    });
    expect(knowledgeSourceCreateSchema.parse({ kind: 'gdrive', name: 'Policies' })).toMatchObject({
      config: { folderIds: [] },
    });
  });

  it('does not create an article or a file source directly', () => {
    expect(knowledgeSourceCreateSchema.safeParse({ kind: 'article', name: 'x' }).success).toBe(
      false,
    );
    expect(knowledgeSourceCreateSchema.safeParse({ kind: 'file', name: 'x' }).success).toBe(false);
  });
});

describe('knowledgeSourceUpdateSchema', () => {
  it('lets a source be re-scoped without touching anything else', () => {
    expect(knowledgeSourceUpdateSchema.parse({ visibility: 'public' })).toEqual({
      visibility: 'public',
    });
    expect(knowledgeSourceUpdateSchema.safeParse({ schedule: 'automatic' }).success).toBe(false);
  });
});

describe('knowledgeFilePresignSchema', () => {
  it('takes the four document types up to 25 MB', () => {
    const presign = (mime: string, size: number) =>
      knowledgeFilePresignSchema.safeParse({ fileName: 'a', mime, size }).success;

    expect(presign('application/pdf', 25 * 1024 * 1024)).toBe(true);
    expect(presign('text/markdown', 10)).toBe(true);
    expect(presign('application/pdf', 25 * 1024 * 1024 + 1)).toBe(false);
    expect(presign('image/png', 10)).toBe(false);
  });
});

describe('knowledgeLogQuerySchema', () => {
  it('reads the limit from a query string', () => {
    expect(knowledgeLogQuerySchema.parse({ limit: '20' })).toEqual({ level: 'all', limit: 20 });
  });
});
