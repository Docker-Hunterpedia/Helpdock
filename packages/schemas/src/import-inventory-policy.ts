import type { ImportSource } from './import.js';
import type { ImportScope } from './import-api.js';

/** Freshdesk has no archive list; Zoho needs a reviewed inventory only when explicitly selected. */
export function importRequiresTicketInventory(source: ImportSource, scope: ImportScope): boolean {
  return (
    (source === 'freshdesk' || (source === 'zohodesk' && scope.useTicketInventory === true)) &&
    scope.entities.some((entity) => ['ticket', 'message', 'attachment', 'tag'].includes(entity))
  );
}
