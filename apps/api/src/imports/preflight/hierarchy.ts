import type { ImportRecord } from '@helpdock/schemas';

export type ImportHierarchyNode = {
  externalId: string;
  parentExternalId: string | null;
  key?: string;
};

export function importHierarchyNode(record: ImportRecord): ImportHierarchyNode {
  const externalId = record.payload.externalId;
  switch (record.entity) {
    case 'category':
      return { externalId, parentExternalId: record.payload.parentExternalId ?? null };
    case 'section':
      return { externalId, parentExternalId: record.payload.parentSectionExternalId ?? null };
    case 'article':
      return { externalId, parentExternalId: record.payload.translationOf ?? null };
    default:
      return { externalId, parentExternalId: null };
  }
}

/** Physical keys detect aliased category/section loops; article translations use their native source IDs. */
export async function importHierarchyCycle(
  start: ImportHierarchyNode,
  read: (externalId: string) => Promise<ImportHierarchyNode | null>,
): Promise<string[] | null> {
  const positions = new Map<string, number>();
  const path: string[] = [];
  let current: ImportHierarchyNode | null = start;
  while (current) {
    const { externalId, parentExternalId: parent } = current;
    const key = current.key ?? externalId;
    const position = positions.get(key);
    if (position !== undefined) return [...path.slice(position), externalId];
    positions.set(key, path.length);
    path.push(externalId);
    if (!parent) return null;
    current = await read(parent);
  }
  return null;
}
