import type { ImportSource } from '@helpdock/schemas';

/** Only sources with a production runtime may be advertised or allocated. */
export const AVAILABLE_IMPORT_SOURCES: readonly ImportSource[] = [
  'zendesk',
  'freshdesk',
  'zohodesk',
  'file',
];
export const TICKET_INVENTORY_SOURCES: readonly ImportSource[] = ['freshdesk', 'zohodesk'];
