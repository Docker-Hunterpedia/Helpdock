import type { ImportAttachmentRef, ImportEntity, ImportRecord } from '@helpdock/schemas';
import { importAttachmentRefSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { Connector, ConnectorContext, ImportCursor, ProposedMapping } from '../connector.js';
import { ConnectorError } from '../errors.js';
import { fetchZendeskAttachment } from './attachment-fetch.js';
import { ZendeskClient } from './client.js';
import { exportZendeskContacts } from './contacts-export.js';
import { type ZendeskCredentials, zendeskCredentialsSchema } from './contracts.js';
import { exportZendeskGroups, exportZendeskTickets, exportZendeskUsers } from './core-export.js';
import { exportZendeskCsat } from './csat-export.js';
import { exportZendeskFields } from './fields-export.js';
import { exportZendeskGuide } from './guide-export.js';
import { zendeskValueMapping } from './mappings.js';
import { exportZendeskOrganizations } from './organizations-export.js';
import { exportZendeskTags } from './tags-export.js';
import { exportZendeskThread } from './threads-export.js';

export class ZendeskConnector implements Connector<ZendeskCredentials> {
  readonly source = 'zendesk' as const;
  readonly credentialsSchema = zendeskCredentialsSchema;
  readonly entities = [
    'ticket',
    'user',
    'organization',
    'group',
    'contact',
    'message',
    'attachment',
    'field',
    'tag',
    'activity',
    'csat',
    'category',
    'section',
    'article',
  ] as const;

  constructor(private readonly options: { apiRoot?: string } = {}) {}

  async test(context: ConnectorContext<ZendeskCredentials>) {
    const client = new ZendeskClient(context, this.options.apiRoot);
    try {
      const response = await client.json(
        '/api/v2/users/me.json',
        z.object({ user: z.object({ role: z.string() }) }),
      );
      return response.user.role === 'admin'
        ? { ok: true as const, account: context.credentials.subdomain }
        : { ok: false as const, reason: 'credentials-refused' as const };
    } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
      return {
        ok: false as const,
        reason: error.code === 'record-unavailable' ? ('invalid-response' as const) : error.code,
      };
    }
  }

  extract(
    context: ConnectorContext<ZendeskCredentials>,
    entity: ImportEntity,
    cursor: ImportCursor | null,
    since?: Date,
  ) {
    const client = new ZendeskClient(context, this.options.apiRoot);
    switch (entity) {
      case 'ticket':
        return exportZendeskTickets(client, cursor, since);
      case 'user':
        return exportZendeskUsers(client, cursor, since);
      case 'organization':
        return exportZendeskOrganizations(client, cursor, since);
      case 'group':
        return exportZendeskGroups(client, cursor);
      case 'contact':
        return exportZendeskContacts(client, cursor, since);
      case 'field':
        return exportZendeskFields(client, cursor);
      case 'tag':
        return exportZendeskTags(client, cursor, since);
      case 'csat':
        return exportZendeskCsat(client, cursor);
      case 'category':
      case 'section':
      case 'article':
        return exportZendeskGuide(client, entity, cursor);
      case 'message':
      case 'attachment':
      case 'activity':
        return exportZendeskThread(client, { mode: entity, cursor, since });
      default:
        throw new ConnectorError('invalid-response');
    }
  }

  async fetchAttachment(
    context: ConnectorContext<ZendeskCredentials>,
    request: ImportAttachmentRef,
  ) {
    const ref = importAttachmentRefSchema.parse(request);
    const client = new ZendeskClient(context, this.options.apiRoot);
    return fetchZendeskAttachment(context, client, ref);
  }

  defaultMappings(sample: readonly ImportRecord[]): ProposedMapping[] {
    const mappings = new Map<string, ProposedMapping>();
    for (const record of sample) {
      if (record.entity !== 'ticket') continue;
      for (const [kind, source] of [
        ['priority', record.payload.priority],
        ['channel', record.payload.channel],
      ] as const) {
        if (source === undefined) continue;
        const proposal = zendeskValueMapping(kind, source);
        if (proposal) mappings.set(`${kind}:${source}`, proposal);
      }
    }
    return [...mappings.values()];
  }
}
