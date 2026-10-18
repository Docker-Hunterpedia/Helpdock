import { importRecordSchema } from '@helpdock/schemas';
import { expect, it } from 'vitest';
import { requiredImportReferences } from './references.js';

it.each(['agent', 'customer', 'system'] as const)(
  'resolves a historical %s author without treating a system actor as staff',
  (authorKind) => {
    const record = importRecordSchema.parse({
      entity: 'message',
      payload: {
        externalId: 'reply',
        ticketExternalId: 'ticket',
        authorKind,
        authorExternalId: 'author',
        public: false,
        bodyText: 'Historical note',
        createdAt: '2020-01-01T00:00:00Z',
        attachments: [],
      },
    });
    expect(requiredImportReferences(record)).toEqual([
      { entity: 'ticket', externalId: 'ticket', relation: 'ticket' },
      ...(authorKind === 'system'
        ? []
        : [
            {
              entity: authorKind === 'agent' ? 'user' : 'contact',
              externalId: 'author',
              relation: 'author',
            },
          ]),
    ]);
  },
);
it('blocks an anonymous non-system historical author rather than assigning a guessed person', () => {
  const record = importRecordSchema.parse({
    entity: 'activity',
    payload: {
      externalId: 'audit',
      ticketExternalId: 'ticket',
      authorKind: 'agent',
      action: 'status_changed',
      createdAt: '2020-01-01T00:00:00Z',
    },
  });
  expect(() => requiredImportReferences(record)).toThrow('author-unmapped');
});
it('includes translation and section dependencies for an Arabic knowledge article', () => {
  const record = importRecordSchema.parse({
    entity: 'article',
    payload: {
      externalId: 'arabic',
      translationOf: 'english',
      sectionExternalId: 'section',
      locale: 'ar',
      title: 'مساعدة',
      bodyHtml: '<p>مساعدة</p>',
      draft: true,
      internal: true,
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-01T00:00:00Z',
    },
  });
  expect(requiredImportReferences(record)).toEqual([
    { entity: 'section', externalId: 'section', relation: 'section-parent' },
    { entity: 'article', externalId: 'english', relation: 'translation' },
  ]);
});
