import { importRecordSchema } from '@helpdock/schemas';
import { expect, it } from 'vitest';
import { importRecordParent } from './record-parent.js';

it('groups a nested source section under its category while retaining its separate section ancestry', () => {
  const record = importRecordSchema.parse({
    entity: 'section',
    payload: {
      externalId: 'child',
      parentExternalId: 'category',
      parentSectionExternalId: 'parent-section',
      names: { en: 'Child' },
    },
  });
  expect(importRecordParent(record)).toBe('category');
});
it('groups a translation under its section rather than the primary article', () => {
  const record = importRecordSchema.parse({
    entity: 'article',
    payload: {
      externalId: 'translation',
      sectionExternalId: 'section',
      translationOf: 'primary',
      locale: 'ar',
      title: 'مساعدة',
      bodyHtml: '<p>مساعدة</p>',
      draft: false,
      internal: false,
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-01T00:00:00Z',
    },
  });
  expect(importRecordParent(record)).toBe('section');
});
