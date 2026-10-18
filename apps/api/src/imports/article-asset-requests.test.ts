import { hcMediaPath, importArticleSchema } from '@helpdock/schemas';
import { expect, it } from 'vitest';
import {
  importArticleAssetMetadataHash,
  importArticleAssetRequests,
} from './article-asset-requests.js';

const brandId = '0192a000-0000-7000-8000-000000000001';
const article = importArticleSchema.parse({
  externalId: 'original',
  sectionExternalId: 'section',
  locale: 'en',
  title: 'Original',
  bodyHtml: '<p>Body</p>',
  draft: false,
  internal: true,
  createdAt: '2013-11-01T00:00:00Z',
  updatedAt: '2020-01-01T00:00:00Z',
});

it('keeps download and image uses distinct while binding repeated decoded image references to the declared native file', () => {
  const ref = {
    externalId: 'native-image',
    fileName: 'original.png',
    size: 123,
    url: 'https://vendor.test/image?x=1&y=2',
  };
  const requests = importArticleAssetRequests(
    {
      ...article,
      attachments: [ref],
      bodyHtml:
        '<img src="https://vendor.test/image?x=1&amp;y=2"><img src="https://vendor.test/image?x=1&amp;y=2">',
    },
    brandId,
    'zohodesk',
  );
  expect(requests).toHaveLength(2);
  expect(requests.map((request) => request.usage)).toEqual(['download', 'image']);
  expect(requests[1]).toMatchObject({
    identity: { externalId: ref.externalId, fileName: ref.fileName },
    sources: [ref.url],
    input: { kind: 'reference', ref },
  });
  expect(requests[0]!.key).not.toBe(requests[1]!.key);
  expect(importArticleAssetMetadataHash(requests[0]!)).not.toBe(
    importArticleAssetMetadataHash(requests[1]!),
  );
});

it('retains bounded inline raster data without fabricating an HTTP endpoint or decoding it as SVG', () => {
  const source = 'data:image/png;base64,iVBORw0KGgo=';
  const requests = importArticleAssetRequests(
    { ...article, bodyHtml: `<img src="${source}">` },
    brandId,
    'file',
  );
  expect(requests).toMatchObject([
    {
      usage: 'image',
      identity: { fileName: 'image', contentType: 'image/png', size: 8 },
      input: { kind: 'inline', mime: 'image/png', base64: 'iVBORw0KGgo=' },
    },
  ]);
  for (const src of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,iVBORw0KGgo'])
    expect(() =>
      importArticleAssetRequests({ ...article, bodyHtml: `<img src="${src}">` }, brandId, 'file'),
    ).toThrow();
});

it('rewrites vendor view aliases using the native file fetch authority rather than downloading the displayed URL', () => {
  const ref = {
    externalId: 'native-image',
    fileName: 'historical.png',
    size: 123,
    url: 'https://vendor.test/api/files/12',
    sourceUrls: ['https://vendor.test/support/DocsDisplay?attachId=12&action=view'],
  };
  const requests = importArticleAssetRequests(
    { ...article, attachments: [ref], bodyHtml: `<img src="${ref.sourceUrls[0]}">` },
    brandId,
    'zohodesk',
  );
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({
    usage: 'image',
    sources: ref.sourceUrls,
    input: { kind: 'reference', ref },
  });
  expect(requests[0]?.sources).toEqual([ref.url, ...ref.sourceUrls]);
  expect(importArticleAssetMetadataHash(requests[1]!)).toBe(
    importArticleAssetMetadataHash({
      usage: 'image',
      identity: { externalId: ref.externalId, fileName: ref.fileName, size: ref.size },
    }),
  );
});

it('refuses ambiguous vendor aliases instead of rewriting two native files to whichever one was encountered first', () => {
  const alias = 'https://vendor.test/display/file';
  expect(() =>
    importArticleAssetRequests(
      {
        ...article,
        attachments: [
          {
            externalId: 'native-1',
            fileName: 'one.pdf',
            url: 'https://vendor.test/api/1',
            sourceUrls: [alias],
          },
          {
            externalId: 'native-2',
            fileName: 'two.pdf',
            url: 'https://vendor.test/api/2',
            sourceUrls: [alias],
          },
        ],
      },
      brandId,
      'zohodesk',
    ),
  ).toThrow();
});

it('allows safe bundle members only for the file source and leaves existing same-brand media to the normal loader checks', () => {
  const source = {
    ...article,
    bodyHtml: `<img src="attachments/original.png"><img src="${hcMediaPath(brandId, brandId)}">`,
  };
  expect(importArticleAssetRequests(source, brandId, 'file')).toMatchObject([
    { input: { kind: 'reference', ref: { bundlePath: 'attachments/original.png' } } },
  ]);
  expect(() => importArticleAssetRequests(source, brandId, 'zendesk')).toThrow();
  expect(() =>
    importArticleAssetRequests(
      { ...article, bodyHtml: '<img src="javascript:unsafe()">' },
      brandId,
      'file',
    ),
  ).toThrow();
});

it('refuses an article that exceeds the bounded preparation manifest', () => {
  const bodyHtml = Array.from(
    { length: 1001 },
    (_, index) => `<img src="https://vendor.test/${index}.png">`,
  ).join('');
  expect(() => importArticleAssetRequests({ ...article, bodyHtml }, brandId, 'zendesk')).toThrow();
});

it('resolves decoded relative images against each copy origin and coalesces equivalent absolute locators', () => {
  const relative = '/DocsDisplay?blockId=original&mode=inline';
  const absolute = `https://desk.zoho.eu${relative}`;
  const requests = importArticleAssetRequests(
    {
      ...article,
      assetOrigin: 'https://desk.zoho.eu',
      bodyHtml: `<img src="/DocsDisplay?blockId=original&amp;mode=inline"><img src="${absolute}">`,
      published: {
        title: 'Original public copy',
        bodyHtml: '<img src="/public.png">',
        publishedAt: null,
        assetOrigin: 'https://public.example.test',
      },
    },
    brandId,
    'zohodesk',
  );
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({
    usage: 'image',
    sources: [relative, absolute],
    input: { kind: 'reference', ref: { url: absolute } },
  });
  expect(requests[1]).toMatchObject({
    usage: 'image',
    sources: ['/public.png'],
    input: { kind: 'reference', ref: { url: 'https://public.example.test/public.png' } },
  });
});

it('uses native fetch authority for a relative view alias rather than replaying credentials to the view URL', () => {
  const ref = {
    externalId: 'native-image',
    fileName: 'original.png',
    url: 'https://desk.zoho.eu/api/files/1',
    sourceUrls: ['https://desk.zoho.eu/DocsDisplay?blockId=original'],
  };
  const requests = importArticleAssetRequests(
    {
      ...article,
      assetOrigin: 'https://desk.zoho.eu',
      attachments: [ref],
      bodyHtml: '<img src="/DocsDisplay?blockId=original">',
    },
    brandId,
    'zohodesk',
  );
  expect(requests[1]).toMatchObject({
    sources: ['/DocsDisplay?blockId=original'],
    input: { kind: 'reference', ref },
  });
});

it.each([
  'https://user:password@vendor.test',
  'https://vendor.test/path',
  'https://vendor.test?token=secret',
  'https://vendor.test#fragment',
  'file:///etc',
])('refuses asset origin %s before deriving a download request', (assetOrigin) => {
  expect(() =>
    importArticleAssetRequests(
      { ...article, assetOrigin, bodyHtml: '<img src="/original.png">' },
      brandId,
      'zohodesk',
    ),
  ).toThrow();
});

it('prepares both source copies without losing published-only files or accepting conflicting metadata for a shared identity', () => {
  const draft = {
    externalId: 'working-file',
    fileName: 'working.pdf',
    url: 'https://vendor.test/working.pdf',
  };
  const publicFile = {
    externalId: 'published-file',
    fileName: 'published.pdf',
    url: 'https://vendor.test/published.pdf',
  };
  const source = {
    ...article,
    attachments: [draft],
    published: {
      title: 'Published title',
      bodyHtml: '<p>Published body</p>',
      publishedAt: null,
      attachments: [publicFile],
    },
  };
  expect(
    importArticleAssetRequests(source, brandId, 'zendesk').map(
      (request) => request.identity.externalId,
    ),
  ).toEqual(['working-file', 'published-file']);
  expect(() =>
    importArticleAssetRequests(
      {
        ...source,
        published: { ...source.published, attachments: [{ ...draft, fileName: 'different.pdf' }] },
      },
      brandId,
      'zendesk',
    ),
  ).toThrow();
});
