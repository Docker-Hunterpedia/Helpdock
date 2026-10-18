import { hashImportValue } from '@helpdock/importers';
import { expect, it } from 'vitest';
import { importedArticleContentHash } from './article-content-hash.js';
import { articleLoadSchema } from './knowledge-contracts.js';

const input = articleLoadSchema.parse({
  brandId: '0192a000-0000-7000-8000-000000000001',
  runId: '0192a000-0000-7000-8000-000000000002',
  source: 'zendesk',
  record: {
    externalId: 'article',
    sectionExternalId: 'section',
    locale: 'en',
    title: 'Manual',
    bodyHtml: '<p><a href="https://vendor.test/manual?token=old">Manual</a></p>',
    attachments: [
      {
        externalId: 'manual',
        fileName: 'manual.pdf',
        size: 20,
        url: 'https://vendor.test/manual?token=old',
        sourcePage: 1,
      },
    ],
    draft: false,
    internal: false,
    createdAt: '2019-01-01T00:00:00Z',
    updatedAt: '2019-01-01T00:00:00Z',
  },
  preparedBodyHtml: '<p>Managed content</p>',
});

it('ignores transport rotation after asset preparation while retaining content and metadata changes', () => {
  const body = input.preparedBodyHtml;
  const original = importedArticleContentHash(input, body, 'section-id', true);
  const rotated = articleLoadSchema.parse({
    ...input,
    record: {
      ...input.record,
      bodyHtml: input.record.bodyHtml.replace('old', 'new'),
      attachments: [
        {
          ...input.record.attachments![0],
          url: 'https://vendor.test/manual?token=new',
          sourcePage: 7,
          sourceUrls: ['https://vendor.test/display/manual?token=new'],
        },
      ],
    },
  });
  expect(importedArticleContentHash(rotated, body, 'section-id', true)).toBe(original);
  for (const changed of [
    { ...rotated, record: { ...rotated.record, title: 'Updated manual' } },
    {
      ...rotated,
      record: {
        ...rotated.record,
        attachments: [{ ...rotated.record.attachments![0]!, fileName: 'renamed.pdf' }],
      },
    },
  ])
    expect(importedArticleContentHash(changed, body, 'section-id', true)).not.toBe(original);
  expect(importedArticleContentHash(input, '<p>Changed body</p>', 'section-id', true)).not.toBe(
    original,
  );
  expect(importedArticleContentHash(input, body, 'other-section', true)).not.toBe(original);
});

it('preserves existing receipts for articles without asset preparation', () => {
  const bodyHtml = input.preparedBodyHtml,
    sectionId = 'section-id';
  expect(importedArticleContentHash(input, bodyHtml, sectionId, false)).toBe(
    hashImportValue({ record: input.record, bodyHtml, sectionId }),
  );
});

it('hashes an inline-image article without inventing an undefined attachment list', () => {
  const { attachments: _files, ...record } = input.record;
  const withoutFiles = articleLoadSchema.parse({ ...input, record });
  expect(
    importedArticleContentHash(withoutFiles, input.preparedBodyHtml, 'section-id', true),
  ).toMatch(/^[0-9a-f]{64}$/);
});

it('binds the public snapshot to its own prepared content while ignoring rotated source file URLs', () => {
  const dual = articleLoadSchema.parse({
    ...input,
    record: {
      ...input.record,
      published: {
        title: 'Published title',
        bodyHtml: '<p>Source published body</p>',
        publishedAt: null,
        attachments: input.record.attachments,
      },
    },
    preparedPublishedBodyHtml: '<p>Prepared public content</p>',
  });
  const original = importedArticleContentHash(dual, dual.preparedBodyHtml, 'section-id', true);
  const rotated = articleLoadSchema.parse({
    ...dual,
    record: {
      ...dual.record,
      published: {
        ...dual.record.published,
        bodyHtml: '<p>Same source with a refreshed transport URL</p>',
        attachments: [
          {
            ...input.record.attachments![0]!,
            url: 'https://vendor.test/manual?token=rotated',
            sourceUrls: ['https://vendor.test/display/manual?token=rotated'],
          },
        ],
      },
    },
  });
  expect(importedArticleContentHash(rotated, dual.preparedBodyHtml, 'section-id', true)).toBe(
    original,
  );
  expect(
    importedArticleContentHash(
      { ...dual, preparedPublishedBodyHtml: '<p>Changed public content</p>' },
      dual.preparedBodyHtml,
      'section-id',
      true,
    ),
  ).not.toBe(original);
});
