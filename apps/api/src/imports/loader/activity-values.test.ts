import { uuidv7 } from '@helpdock/db';
import { importActivitySchema } from '@helpdock/schemas';
import { expect, it } from 'vitest';
import { importedActivityValues } from './activity-values.js';
import type { ImportedAuthor } from './load-authors.js';

const authorId = uuidv7();
const authors: ImportedAuthor[] = [
  { authorType: 'staff', authorId, authorDisplay: null },
  { authorType: 'contact', authorId, authorDisplay: null },
  { authorType: 'system', authorId: null, authorDisplay: 'Original agent' },
];
it.each(authors)(
  'keeps source actions inert and preserves %j authors without promoting contacts or names',
  (author) => {
    const event = importActivitySchema.parse({
      externalId: '001',
      ticketExternalId: '42',
      authorExternalId: 'legacy-author',
      authorKind: author.authorType === 'contact' ? 'customer' : 'agent',
      action: 'email.sent',
      from: { status: 'open' },
      to: { status: 'pending' },
      details: { reason: 'متابعة الطلب' },
      createdAt: '2019-01-02T00:00:00+03:00',
    });
    expect(importedActivityValues('zendesk', event, author)).toEqual({
      actorType: author.authorType === 'staff' ? 'staff' : 'system',
      actorId: author.authorType === 'staff' ? authorId : 'import:zendesk:legacy-author',
      action: 'ticket.imported.event',
      via: 'system',
      from: { status: 'open' },
      to: {
        changes: { status: 'pending' },
        sourceEvent: {
          source: 'zendesk',
          externalId: '001',
          action: 'email.sent',
          authorExternalId: 'legacy-author',
          authorType: author.authorType,
          authorId: author.authorId,
          authorDisplay: author.authorDisplay,
          details: { reason: 'متابعة الطلب' },
        },
      },
      createdAt: new Date('2019-01-01T21:00:00Z'),
    });
  },
);
