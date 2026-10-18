import { expect, it } from 'vitest';
import type { ImportEntity, ImportSource } from './import.js';
import { importRequiresTicketInventory } from './import-inventory-policy.js';

it.each<{
  source: ImportSource;
  entities: ImportEntity[];
  useTicketInventory?: boolean;
  required: boolean;
}>([
  { source: 'freshdesk', entities: ['ticket'], useTicketInventory: false, required: true },
  { source: 'freshdesk', entities: ['contact'], required: false },
  { source: 'zohodesk', entities: ['ticket', 'message', 'attachment', 'tag'], required: false },
  { source: 'zohodesk', entities: ['message'], useTicketInventory: true, required: true },
  { source: 'zohodesk', entities: ['contact'], useTicketInventory: true, required: false },
  { source: 'zendesk', entities: ['ticket'], useTicketInventory: true, required: false },
])(
  'source=$source entities=$entities opt-in=$useTicketInventory requires inventory=$required',
  ({ source, entities, useTicketInventory, required }) => {
    expect(
      importRequiresTicketInventory(source, {
        entities,
        useTicketInventory,
        rebuildAllReports: false,
      }),
    ).toBe(required);
  },
);
