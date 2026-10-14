import type { ImportRecord } from '@helpdock/schemas';

/** The staging parent groups ticket history or knowledge children; inline attachment sharing remains valid. */
export function importRecordParent(record: ImportRecord): string | null {
  switch (record.entity) {
    case 'message':
    case 'attachment':
    case 'csat':
    case 'activity':
      return record.payload.ticketExternalId;
    case 'article':
      return record.payload.sectionExternalId;
    case 'section':
      return record.payload.parentExternalId;
    case 'category':
      return record.payload.parentExternalId ?? null;
    default:
      return null;
  }
}
