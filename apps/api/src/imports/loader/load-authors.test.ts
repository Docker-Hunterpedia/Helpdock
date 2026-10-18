import type { DbTransaction } from '@helpdock/db';
import { expect, it } from 'vitest';
import { importedAuthor } from './load-authors.js';

// These branches must not query the database: unavailable identities grant no
// local attribution. Mapped staff/contact queries are covered by the writer integration suite.
const unusedTransaction = new Proxy({} as DbTransaction, {
  get() {
    throw new Error('Unexpected author query');
  },
});
const input = {
  brandId: '0193b000-0000-7000-8000-000000000901',
  authors: {
    existing: { kind: 'staff' as const, id: '0193b000-0000-7000-8000-000000000902' },
  },
};

it('retains a source-only author name without attaching a mapped local staff identity', async () => {
  expect(
    await importedAuthor(unusedTransaction, input, {
      authorKind: 'system',
      authorExternalId: 'existing',
      authorName: 'Original author without a stable source ID',
    }),
  ).toEqual({
    authorType: 'system',
    authorId: null,
    authorDisplay: 'Original author without a stable source ID',
  });
});

it.each(['agent', 'customer'] as const)(
  'does not use a display name to bypass an unmapped %s identity',
  async (authorKind) => {
    await expect(
      importedAuthor(unusedTransaction, input, { authorKind, authorName: 'Unmapped author' }),
    ).rejects.toMatchObject({ code: 'author-unmapped' });
  },
);
