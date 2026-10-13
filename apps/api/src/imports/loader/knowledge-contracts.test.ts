import { HC_BODY_MAX, HC_CATEGORY_DESCRIPTION_MAX, HC_TITLE_MAX } from '@helpdock/schemas';
import { expect, it } from 'vitest';
import {
  articleLoadSchema,
  importedDescriptions,
  importedNames,
  sourceDescriptions,
} from './knowledge-contracts.js';

const article = {
  brandId: '0192a000-0000-7000-8000-000000000001',
  runId: '0192a000-0000-7000-8000-000000000002',
  source: 'zohodesk',
  record: {
    externalId: 'article-1',
    sectionExternalId: 'section-1',
    locale: 'en',
    title: 'x'.repeat(HC_TITLE_MAX),
    bodyHtml: '<p>Original</p>',
    draft: false,
    internal: false,
    createdAt: '2020-01-01T00:00:00Z',
    updatedAt: '2021-01-01T00:00:00Z',
  },
  preparedBodyHtml: 'x'.repeat(HC_BODY_MAX),
};

it('accepts full destination bounds but refuses bodies that cannot be stored intact', () => {
  expect(articleLoadSchema.parse(article).record.title).toBe(article.record.title);
  expect(
    articleLoadSchema.safeParse({ ...article, preparedBodyHtml: 'x'.repeat(HC_BODY_MAX + 1) })
      .success,
  ).toBe(false);
  expect(
    articleLoadSchema.safeParse({
      ...article,
      record: { ...article.record, title: 'x'.repeat(HC_TITLE_MAX + 1) },
    }).success,
  ).toBe(false);
});

it('keeps full source descriptions separately from bounded bilingual display excerpts', () => {
  const descriptions = {
    en: `${'x'.repeat(HC_CATEGORY_DESCRIPTION_MAX - 1)}😀tail`,
    ar: 'وصف القسم',
  };
  expect(sourceDescriptions(descriptions)).toEqual(descriptions);
  expect(importedDescriptions(descriptions)).toEqual({
    en: 'x'.repeat(HC_CATEGORY_DESCRIPTION_MAX - 1),
    ar: descriptions.ar,
  });
  expect(importedNames({ ar: 'قسم المساعدة' })).toEqual({ en: '', ar: 'قسم المساعدة' });
});
