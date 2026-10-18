import {
  type ImportMapping,
  type ImportTicket,
  importMappingsSchema,
  importTicketSchema,
} from '@helpdock/schemas';
import { ImportLoadError } from './contracts.js';

function confirmedMapping<K extends ImportMapping['kind']>(
  mappings: Map<string, ImportMapping>,
  kind: K,
  externalValue: string,
) {
  const mapping = mappings.get(`${kind}\0${externalValue}`);
  if (!mapping || mapping.kind !== kind) throw new ImportLoadError('mapping-invalid');
  // The key and checked discriminant establish K; TypeScript cannot narrow a generic discriminant.
  return mapping as Extract<ImportMapping, { kind: K }>;
}

/** Empty keys are explicit admin-confirmed defaults for missing source priority/channel/group. */
export function selectTicketMappings(ticket: ImportTicket, proposed: ImportMapping[]) {
  const record = importTicketSchema.parse(ticket);
  const mappings = new Map(
    importMappingsSchema
      .parse(proposed)
      .map((mapping) => [`${mapping.kind}\0${mapping.externalValue}`, mapping]),
  );
  return {
    ...confirmedMapping(mappings, 'status', record.status).target,
    ...confirmedMapping(mappings, 'group', record.groupExternalId ?? '').target,
    ...confirmedMapping(mappings, 'priority', record.priority ?? '').target,
    ...confirmedMapping(mappings, 'channel', record.channel ?? '').target,
    assignee: record.assigneeExternalId
      ? confirmedMapping(mappings, 'agent', record.assigneeExternalId).target
      : null,
    tags: [...new Set(record.tags)].map((externalValue) => ({
      externalValue,
      ...confirmedMapping(mappings, 'tag', externalValue).target,
    })),
  };
}
