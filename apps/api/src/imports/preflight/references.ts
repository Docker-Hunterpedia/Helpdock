import type { ImportEntity, ImportRecord } from '@helpdock/schemas';
import { ImportLoadError } from '../loader/contracts.js';

export type ImportReference = {
  entity: ImportEntity;
  externalId: string;
  relation:
    | 'requester'
    | 'cc'
    | 'assignee'
    | 'organization'
    | 'ticket'
    | 'message'
    | 'attachment'
    | 'author'
    | 'category-parent'
    | 'section-parent'
    | 'translation';
};

/** Source dependencies only; confirmed routing/field targets are validated separately. */
export function requiredImportReferences(record: ImportRecord): ImportReference[] {
  const refs: ImportReference[] = [];
  const add = (
    entity: ImportEntity,
    externalId: string | undefined,
    relation: ImportReference['relation'],
  ) => {
    if (externalId !== undefined) refs.push({ entity, externalId, relation });
  };
  switch (record.entity) {
    case 'ticket':
      add('contact', record.payload.requesterExternalId, 'requester');
      for (const id of record.payload.ccExternalIds ?? []) add('contact', id, 'cc');
      add('user', record.payload.assigneeExternalId, 'assignee');
      add('organization', record.payload.organizationExternalId, 'organization');
      break;
    case 'contact':
      add('organization', record.payload.organizationExternalId, 'organization');
      break;
    case 'message':
    case 'activity':
      add('ticket', record.payload.ticketExternalId, 'ticket');
      if (record.payload.authorKind !== 'system') {
        if (!record.payload.authorExternalId) throw new ImportLoadError('author-unmapped');
        add(
          record.payload.authorKind === 'agent' ? 'user' : 'contact',
          record.payload.authorExternalId,
          'author',
        );
      }
      if (record.entity === 'message')
        for (const ref of record.payload.attachments)
          add('attachment', ref.externalId, 'attachment');
      break;
    case 'attachment':
      add('ticket', record.payload.ticketExternalId, 'ticket');
      add('message', record.payload.messageExternalId, 'message');
      break;
    case 'csat':
      add('ticket', record.payload.ticketExternalId, 'ticket');
      break;
    case 'category':
      add('category', record.payload.parentExternalId, 'category-parent');
      break;
    case 'section':
      add('category', record.payload.parentExternalId, 'category-parent');
      add('section', record.payload.parentSectionExternalId, 'section-parent');
      break;
    case 'article':
      add('section', record.payload.sectionExternalId, 'section-parent');
      add('article', record.payload.translationOf, 'translation');
      break;
  }
  return refs;
}
