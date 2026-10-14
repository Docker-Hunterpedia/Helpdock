import type { ImportActivity, ImportMessage } from '@helpdock/schemas';
import { ImportLoadError } from './contracts.js';

export type ThreadAuthorReference = Pick<
  ImportMessage | ImportActivity,
  'authorExternalId' | 'authorKind'
>;

export function threadAuthorKinds(references: readonly ThreadAuthorReference[]) {
  const kinds = new Map<string, 'agent' | 'customer'>();
  for (const reference of references) {
    if (reference.authorKind === 'system') continue;
    if (!reference.authorExternalId) throw new ImportLoadError('author-unmapped');
    const previous = kinds.get(reference.authorExternalId);
    if (previous && previous !== reference.authorKind) throw new ImportLoadError('mapping-invalid');
    kinds.set(reference.authorExternalId, reference.authorKind);
  }
  return kinds;
}
