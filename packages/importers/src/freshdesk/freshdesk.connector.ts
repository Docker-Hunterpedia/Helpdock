import type { ImportAttachmentRef, ImportEntity, ImportRecord } from '@helpdock/schemas';
import { FRESHDESK_IMPORT_ENTITIES } from '@helpdock/schemas';
import { z } from 'zod';
import type { Connector, ConnectorContext, ImportCursor, ProposedMapping } from '../connector.js';
import { ConnectorError } from '../errors.js';
import type { TicketInventory } from '../ticket-inventory.js';
import { fetchFreshdeskAttachment } from './attachment-fetch.js';
import { FreshdeskClient } from './client.js';
import { type FreshdeskCredentials, freshdeskCredentialsSchema } from './contracts.js';
import { exportFreshdeskLegacyCsat } from './csat-export.js';
import { exportFreshdeskFields } from './fields-export.js';
import { exportFreshdeskKnowledge } from './knowledge-export.js';
import { freshdeskValueMapping } from './mappings.js';
import { exportFreshdeskModernCsat } from './modern-csat-export.js';
import {
  exportFreshdeskContacts,
  exportFreshdeskGroups,
  exportFreshdeskOrganizations,
  exportFreshdeskUsers,
} from './people-export.js';
import { exportFreshdeskStatusTickets } from './status-tickets-export.js';
import { exportFreshdeskTags } from './tags-export.js';
import { exportFreshdeskThread } from './threads-export.js';

export class FreshdeskConnector implements Connector<FreshdeskCredentials> {
  readonly source = 'freshdesk' as const;
  readonly credentialsSchema = freshdeskCredentialsSchema;
  readonly entities = FRESHDESK_IMPORT_ENTITIES;

  constructor(private readonly options: { apiRoot?: string; inventory?: TicketInventory } = {}) {}

  async test(context: ConnectorContext<FreshdeskCredentials>) {
    const client = new FreshdeskClient(context, this.options.apiRoot);
    try {
      const agent = await client.json(
        '/api/v2/agents/me',
        z.object({ id: z.number().int().positive(), ticket_scope: z.number().int() }),
      );
      if (agent.ticket_scope !== 1)
        return { ok: false as const, reason: 'credentials-refused' as const };
      // Authentication alone is insufficient: listing agents is an administrator-only export capability.
      await client.page('/api/v2/agents', z.object({ id: z.number().int().positive() }), {
        page: '1',
        per_page: '100',
      });
      return { ok: true as const, account: context.credentials.domain };
    } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
      return {
        ok: false as const,
        reason: error.code === 'record-unavailable' ? ('invalid-response' as const) : error.code,
      };
    }
  }

  extract(
    context: ConnectorContext<FreshdeskCredentials>,
    entity: ImportEntity,
    cursor: ImportCursor | null,
    since?: Date,
  ) {
    const client = new FreshdeskClient(context, this.options.apiRoot);
    switch (entity) {
      case 'ticket':
        return exportFreshdeskStatusTickets(client, cursor, since, this.options.inventory);
      case 'user':
        return exportFreshdeskUsers(client, cursor, since);
      case 'contact':
        return exportFreshdeskContacts(client, cursor, since);
      case 'organization':
        return exportFreshdeskOrganizations(client, cursor, since);
      case 'group':
        return exportFreshdeskGroups(client, cursor);
      case 'field':
        return exportFreshdeskFields(client, cursor);
      case 'tag':
        return exportFreshdeskTags(client, cursor, since, this.options.inventory);
      case 'message':
      case 'attachment':
        return exportFreshdeskThread(client, {
          mode: entity,
          cursor,
          ...(since ? { since } : {}),
          ...(this.options.inventory ? { inventory: this.options.inventory } : {}),
        });
      case 'csat':
        return context.credentials.csatApi === 'legacy'
          ? exportFreshdeskLegacyCsat(client, cursor)
          : exportFreshdeskModernCsat(client, cursor);
      case 'category':
      case 'section':
      case 'article':
        return exportFreshdeskKnowledge(client, entity, cursor);
      default:
        throw new ConnectorError('invalid-response');
    }
  }

  fetchAttachment(context: ConnectorContext<FreshdeskCredentials>, ref: ImportAttachmentRef) {
    return fetchFreshdeskAttachment(
      context,
      new FreshdeskClient(context, this.options.apiRoot),
      ref,
    );
  }

  defaultMappings(sample: readonly ImportRecord[]): ProposedMapping[] {
    const mappings = new Map<string, ProposedMapping>();
    for (const record of sample) {
      if (record.entity !== 'ticket') continue;
      for (const [kind, value] of [
        ['priority', record.payload.priority],
        ['channel', record.payload.channel],
      ] as const) {
        if (value === undefined) continue;
        const proposal = freshdeskValueMapping(kind, value);
        if (proposal) mappings.set(`${kind}:${value}`, proposal);
      }
    }
    return [...mappings.values()];
  }
}
