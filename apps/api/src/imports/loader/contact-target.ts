import { contacts, type DbTransaction } from '@helpdock/db';
import { and, eq } from 'drizzle-orm';
import { ImportLoadError } from './contracts.js';

/** Stable source pointers keep undo semantics; only the current profile target follows a manual merge. */
export async function importedContactTarget(
  tx: DbTransaction,
  scope: { brandId: string; contactId: string },
) {
  const visited = new Set<string>();
  let id = scope.contactId;
  for (let hop = 0; hop < 50; hop += 1) {
    if (visited.has(id)) throw new ImportLoadError('target-unavailable');
    visited.add(id);
    const [contact] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.brandId, scope.brandId)));
    if (!contact || contact.anonymisedAt) throw new ImportLoadError('target-unavailable');
    if (!contact.mergedIntoId) return contact;
    id = contact.mergedIntoId;
  }
  throw new ImportLoadError('target-unavailable');
}
