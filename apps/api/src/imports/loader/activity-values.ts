import type { ImportActivity, ImportSource } from '@helpdock/schemas';
import type { ImportedAuthor } from './load-authors.js';

export function importedActivityValues(
  source: ImportSource,
  event: ImportActivity,
  author: ImportedAuthor,
) {
  return {
    actorType: author.authorType === 'staff' ? ('staff' as const) : ('system' as const),
    actorId:
      author.authorType === 'staff' && author.authorId
        ? author.authorId
        : `import:${source}:${event.authorExternalId ?? 'system'}`,
    action: 'ticket.imported.event',
    via: 'system' as const,
    from: event.from ?? null,
    to: {
      changes: event.to ?? {},
      sourceEvent: {
        source,
        externalId: event.externalId,
        action: event.action,
        authorExternalId: event.authorExternalId ?? null,
        authorType: author.authorType,
        authorId: author.authorId,
        authorDisplay: author.authorDisplay,
        details: event.details ?? {},
      },
    },
    createdAt: new Date(event.createdAt),
  };
}
