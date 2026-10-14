import type { DbTransaction } from '@helpdock/db';
import { HC_MAX_SECTIONS } from '@helpdock/schemas';
import { ImportLoadError } from './contracts.js';
import { importedBreadcrumbNames, importedNames, type SectionLoad } from './knowledge-contracts.js';
import { importedSectionTarget } from './knowledge-targets.js';

export async function importedSectionNames(
  tx: DbTransaction,
  input: SectionLoad,
  categoryId: string,
) {
  const names = importedNames(input.record.names);
  const parentId = input.record.parentSectionExternalId;
  if (!parentId) return { names, parentHash: null };
  const parent = await importedSectionTarget(tx, input, parentId);
  const visited = new Set([input.record.externalId]);
  let ancestorId: string | null = parentId;
  for (let depth = 0; ancestorId; depth++) {
    if (depth >= HC_MAX_SECTIONS || visited.has(ancestorId))
      throw new ImportLoadError('mapping-invalid');
    visited.add(ancestorId);
    const ancestor = await importedSectionTarget(tx, input, ancestorId);
    if (ancestor.categoryId !== categoryId) throw new ImportLoadError('mapping-invalid');
    ancestorId = ancestor.importedParentSectionExternalId;
  }
  return {
    parentHash: parent.sourceHash,
    names: importedBreadcrumbNames(parent.names, names),
  };
}
