import type { SafeFetchInit } from '@helpdock/net';
import { z } from 'zod';
import type { ConnectorContext } from '../connector.js';
import { ConnectorError } from '../errors.js';
import { type ZendeskCredentials, zendeskCredentialsSchema } from './contracts.js';

export class ZendeskClient {
  readonly origin: string;
  private readonly authorization: string;
  private readonly authorRoles = new Map<number, 'agent' | 'customer' | 'system'>();

  constructor(
    private readonly context: ConnectorContext<ZendeskCredentials>,
    apiRoot?: string,
  ) {
    const credentials = zendeskCredentialsSchema.parse(context.credentials);
    this.origin = new URL(apiRoot ?? `https://${credentials.subdomain}.zendesk.com`).origin;
    this.authorization =
      credentials.auth === 'oauth'
        ? `Bearer ${credentials.accessToken}`
        : `Basic ${Buffer.from(`${credentials.email}/token:${credentials.apiToken}`).toString('base64')}`;
  }

  init(): SafeFetchInit {
    return { signal: this.context.signal, headers: { authorization: this.authorization } };
  }

  url(path: string, query: Record<string, string> = {}): string {
    const address = new URL(path, this.origin);
    if (address.origin !== this.origin || address.username || address.password)
      throw new ConnectorError('invalid-response');
    for (const [key, value] of Object.entries(query)) address.searchParams.set(key, value);
    return address.href;
  }

  json<T>(path: string, schema: z.ZodType<T>, query: Record<string, string> = {}): Promise<T> {
    this.context.signal.throwIfAborted();
    return this.context.http.json(this.url(path, query), schema, this.init());
  }

  async ticketJson<T>(
    ticketId: number,
    path: string,
    schema: z.ZodType<T>,
    query: Record<string, string>,
  ): Promise<T | null> {
    try {
      return await this.json(path, schema, query);
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.code !== 'record-unavailable') throw error;
      await this.warnUnavailableTicket(ticketId);
      return null;
    }
  }

  warnUnavailableContact(id: number): Promise<void> {
    return this.context.log({
      level: 'warning',
      entity: 'contact',
      externalId: String(id),
      message: 'import.record-unavailable',
    });
  }

  warnUnavailableTicket(id: number): Promise<void> {
    return this.context.log({
      level: 'warning',
      entity: 'ticket',
      externalId: String(id),
      message: 'import.record-unavailable',
    });
  }

  warnUnsupportedField(externalId: string): Promise<void> {
    return this.context.log({
      level: 'warning',
      entity: 'field',
      externalId,
      message: 'import.field.unsupported-semantics',
    });
  }

  warnLegacyCsatTimestamp(): Promise<void> {
    return this.context.log({
      level: 'warning',
      entity: 'csat',
      message: 'import.csat.timestamp-inferred',
    });
  }

  warnSurveyScaleNormalization(): Promise<void> {
    return this.context.log({
      level: 'warning',
      entity: 'csat',
      message: 'import.csat.scale-normalized',
    });
  }

  warnGuideReadership(externalId: string): Promise<void> {
    return this.context.log({
      level: 'warning',
      entity: 'article',
      externalId,
      message: 'import.knowledge.readership-restricted',
    });
  }

  nextOffset(nextPage: string | null, path: string, current: number): number | null {
    if (nextPage === null) return null;
    const address = new URL(nextPage);
    const page = Number(address.searchParams.get('page'));
    if (
      address.origin !== this.origin ||
      address.pathname !== path ||
      address.username ||
      address.password ||
      !Number.isSafeInteger(page) ||
      page <= current
    )
      throw new ConnectorError('invalid-response');
    return page;
  }

  async authorKind(userId: number): Promise<'agent' | 'customer' | 'system'> {
    const cached = this.authorRoles.get(userId);
    if (cached) return cached;
    const response = await this.json(
      `/api/v2/users/${userId}.json`,
      z.object({
        user: z.object({ id: z.int().positive(), role: z.enum(['end-user', 'agent', 'admin']) }),
      }),
    ).catch(async (error: unknown) => {
      if (!(error instanceof ConnectorError) || error.code !== 'record-unavailable') throw error;
      await this.context.log({
        level: 'warning',
        entity: 'message',
        externalId: String(userId),
        message: 'import.message.author-unavailable',
      });
      return null;
    });
    if (!response) return 'system';
    if (response.user.id !== userId) throw new ConnectorError('invalid-response');
    const kind = response.user.role === 'end-user' ? 'customer' : 'agent';
    if (this.authorRoles.size >= 128) this.authorRoles.clear();
    this.authorRoles.set(userId, kind);
    return kind;
  }

  nextCommentCursor(
    nextPage: string | null,
    path: string,
    after: string | null | undefined,
  ): string {
    if (!nextPage || !after) throw new ConnectorError('invalid-response');
    const address = new URL(nextPage);
    if (
      address.origin !== this.origin ||
      address.pathname !== path ||
      address.username ||
      address.password ||
      address.searchParams.get('page[after]') !== after
    )
      throw new ConnectorError('invalid-response');
    return after;
  }
}
