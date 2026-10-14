import { expect, it } from 'vitest';
import { threadAuthorKinds } from './thread-author-kinds.js';

it('deduplicates person references without inventing accounts for system activity', () => {
  expect([
    ...threadAuthorKinds([
      { authorKind: 'system' },
      { authorKind: 'system', authorExternalId: 'system-service' },
      { authorKind: 'agent', authorExternalId: '301' },
      { authorKind: 'agent', authorExternalId: '301' },
      { authorKind: 'customer', authorExternalId: '201' },
    ]),
  ]).toEqual([
    ['301', 'agent'],
    ['201', 'customer'],
  ]);
});

it('refuses contradictory source author kinds rather than attributing a customer reply to staff', () => {
  expect(() =>
    threadAuthorKinds([
      { authorKind: 'agent', authorExternalId: 'same' },
      { authorKind: 'customer', authorExternalId: 'same' },
    ]),
  ).toThrow('mapping-invalid');
});

it.each(['agent', 'customer'] as const)(
  'refuses a missing %s source identity rather than guessing an author',
  (authorKind) => {
    expect(() => threadAuthorKinds([{ authorKind }])).toThrow('author-unmapped');
  },
);
