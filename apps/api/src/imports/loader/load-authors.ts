import { contacts, type DbTransaction, userBrandRoles } from '@helpdock/db';
import type { ImportMessage } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { ImportLoadError, type TicketLoad } from './contracts.js';

export type ImportedAuthor = Awaited<ReturnType<typeof importedAuthor>>;

export async function importedAuthor(
  tx: DbTransaction,
  input: Pick<TicketLoad, 'brandId' | 'authors'>,
  source: Pick<ImportMessage, 'authorExternalId' | 'authorKind' | 'authorName'>,
) {
  if (source.authorKind === 'system')
    return {
      authorType: 'system' as const,
      authorId: null,
      authorDisplay: source.authorName ?? null,
    };
  const author =
    source.authorExternalId === undefined ? undefined : input.authors[source.authorExternalId];
  if (!author) {
    throw new ImportLoadError('author-unmapped');
  }
  if (
    (source.authorKind === 'customer' && author.kind !== 'contact') ||
    (source.authorKind === 'agent' && author.kind === 'contact') ||
    (author.kind === 'name' && source.authorKind !== 'agent')
  )
    throw new ImportLoadError('mapping-invalid');
  if (author.kind === 'name')
    return { authorType: 'system' as const, authorId: null, authorDisplay: author.name };
  const matches =
    author.kind === 'staff'
      ? await tx
          .select({ id: userBrandRoles.userId })
          .from(userBrandRoles)
          .where(
            and(eq(userBrandRoles.brandId, input.brandId), eq(userBrandRoles.userId, author.id)),
          )
      : await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.brandId, input.brandId), eq(contacts.id, author.id)));
  if (!matches.length) throw new ImportLoadError('mapping-invalid');
  return { authorType: author.kind, authorId: author.id, authorDisplay: null };
}
