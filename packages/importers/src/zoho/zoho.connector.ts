import {
  type ImportAttachmentRef,
  type ImportEntity,
  type ImportRecord,
  ZOHODESK_IMPORT_ENTITIES,
} from '@helpdock/schemas';
import type { Connector, ConnectorContext, ImportCursor, ProposedMapping } from '../connector.js';
import { ConnectorError, RateLimited } from '../errors.js';
import type { TicketInventory } from '../ticket-inventory.js';
import { fetchZohoArticleAttachment } from './article-attachments.js';
import { exportZohoArticles } from './articles-export.js';
import { fetchZohoAttachment } from './attachment-fetch.js';
import { ZohoDeskClient } from './client.js';
import { exportZohoCsat } from './csat-export.js';
import { exportZohoFields } from './fields-export.js';
import { exportZohoHistory } from './history-export.js';
import { zohoValueMapping } from './mappings.js';
import { type ZohoAccessToken, ZohoOAuthSession } from './oauth.js';
import { exportZohoAgents, exportZohoDepartments, exportZohoProfiles } from './people-export.js';
import { probeZohoExport } from './probe.js';
import { type ZohoCredentials, zohoCredentialsSchema } from './regions.js';
import { exportZohoTags } from './tags-export.js';
import { exportZohoTaxonomy } from './taxonomy-export.js';
import { exportZohoTickets } from './tickets-export.js';

export class ZohoConnector implements Connector<ZohoCredentials> {
  readonly source = 'zohodesk' as const;
  readonly credentialsSchema = zohoCredentialsSchema;
  readonly entities = ZOHODESK_IMPORT_ENTITIES;
  private readonly clients = new WeakMap<ConnectorContext<ZohoCredentials>, ZohoDeskClient>();

  constructor(
    private readonly options: {
      apiRoot?: string;
      accountsRoot?: string;
      inventory?: TicketInventory;
      initialAccessToken?: ZohoAccessToken;
      saveAccessToken?: (token: ZohoAccessToken) => Promise<void>;
    } = {},
  ) {}

  private client(context: ConnectorContext<ZohoCredentials>): ZohoDeskClient {
    const known = this.clients.get(context);
    if (known) return known;
    const oauth = new ZohoOAuthSession(context.credentials, context.http, {
      signal: context.signal,
      ...(this.options.accountsRoot ? { accountsRoot: this.options.accountsRoot } : {}),
      ...(this.options.initialAccessToken
        ? { initialAccessToken: this.options.initialAccessToken }
        : {}),
      ...(this.options.saveAccessToken ? { saveAccessToken: this.options.saveAccessToken } : {}),
    });
    const client = new ZohoDeskClient(context, oauth, this.options.apiRoot);
    this.clients.set(context, client);
    return client;
  }

  async test(context: ConnectorContext<ZohoCredentials>) {
    const client = this.client(context);
    try {
      const account = await client.account();
      await probeZohoExport(client);
      return { ok: true as const, account };
    } catch (error) {
      if (error instanceof RateLimited)
        return { ok: false as const, reason: 'vendor-unavailable' as const };
      if (!(error instanceof ConnectorError)) throw error;
      return {
        ok: false as const,
        reason: error.code === 'record-unavailable' ? ('invalid-response' as const) : error.code,
      };
    }
  }

  extract(
    context: ConnectorContext<ZohoCredentials>,
    entity: ImportEntity,
    cursor: ImportCursor | null,
    since?: Date,
  ) {
    const client = this.client(context);
    switch (entity) {
      case 'user':
        return exportZohoAgents(client, cursor);
      case 'contact':
      case 'organization':
        return exportZohoProfiles(client, entity, cursor);
      case 'group':
        return exportZohoDepartments(client, cursor);
      case 'field':
        return exportZohoFields(client, cursor);
      case 'ticket':
        return exportZohoTickets(client, cursor, since, this.options.inventory);
      case 'tag':
        return exportZohoTags(client, cursor, since, this.options.inventory);
      case 'message':
      case 'attachment':
        return exportZohoHistory(client, {
          mode: entity,
          cursor,
          ...(since ? { since } : {}),
          ...(this.options.inventory ? { inventory: this.options.inventory } : {}),
        });
      case 'csat':
        return exportZohoCsat(client, cursor);
      case 'category':
      case 'section':
        return exportZohoTaxonomy(client, entity, cursor);
      case 'article':
        return exportZohoArticles(client, cursor);
      default:
        throw new ConnectorError('invalid-response');
    }
  }

  fetchAttachment(context: ConnectorContext<ZohoCredentials>, ref: ImportAttachmentRef) {
    const client = this.client(context);
    return ref.externalId.startsWith('a:')
      ? fetchZohoArticleAttachment(client, ref)
      : fetchZohoAttachment(client, ref);
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
        const mapping = zohoValueMapping(kind, value);
        if (mapping) mappings.set(`${kind}:${value}`, mapping);
      }
    }
    return [...mappings.values()];
  }
}
