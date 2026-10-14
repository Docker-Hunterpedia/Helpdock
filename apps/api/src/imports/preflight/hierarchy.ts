import type { ImportRecord } from '@helpdock/schemas';

function hierarchyParent(record: ImportRecord): string | undefined {
  switch (record.entity) {
    case 'category':
      return record.payload.parentExternalId;
    case 'section':
      return record.payload.parentSectionExternalId;
    case 'article':
      return record.payload.translationOf;
    default:
      return undefined;
  }
}

/** Iterative traversal avoids recursion limits; absent staged ancestors are checked by reference/target validation. */
export async function importHierarchyCycle(
  start: ImportRecord,
  read: (externalId: string) => Promise<ImportRecord | null>,
): Promise<string[] | null> {
  const positions = new Map<string, number>();
  const path: string[] = [];
  let current: ImportRecord | null = start;
  while (current) {
    const id = current.payload.externalId;
    const position = positions.get(id);
    if (position !== undefined) return [...path.slice(position), id];
    positions.set(id, path.length);
    path.push(id);
    const parent = hierarchyParent(current);
    if (!parent) return null;
    current = await read(parent);
  }
  return null;
}
