import type { SafeFetchInit, SafeFetchResponse } from '@helpdock/net';
import { z } from 'zod';
import type { ConnectorContext } from '../connector.js';
import { ConnectorError } from '../errors.js';
import type { ImportSnapshotScope } from '../http.js';
import { isInvalidUtf8 } from '../utf8.js';
import type { ZohoOAuthSession } from './oauth.js';
import { ZOHO_REGIONS, type ZohoCredentials, zohoCredentialsSchema } from './regions.js';

export class ZohoDeskClient {
  readonly origin: string;
  private readonly credentials: ZohoCredentials;

  constructor(
    private readonly context: ConnectorContext<ZohoCredentials>,
    private readonly oauth: ZohoOAuthSession,
    apiRoot?: string,
  ) {
    this.credentials = zohoCredentialsSchema.parse(context.credentials);
    this.origin = new URL(apiRoot ?? ZOHO_REGIONS[this.credentials.region].desk).origin;
  }

  url(path: string, query: Record<string, string> = {}): string {
    const url = new URL(path, this.origin);
    if (
      url.origin !== this.origin ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith('/api/v1/')
    )
      throw new ConnectorError('invalid-response');
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.href;
  }

  async json<T>(
    path: string,
    schema: z.ZodType<T>,
    query: Record<string, string> = {},
    snapshot?: ImportSnapshotScope,
  ): Promise<T> {
    // Resolve before requesting a token: a malicious locator cannot trigger any
    // credential-bearing network call, including an otherwise legitimate refresh.
    const url = this.url(path, query);
    return this.authorized((init) =>
      this.context.http.json(url, schema, init, { followRedirects: false, snapshot }),
    );
  }

  async request(
    path: string,
    query: Record<string, string> = {},
    snapshot?: ImportSnapshotScope,
  ): Promise<SafeFetchResponse> {
    const url = this.url(path, query);
    return this.authorized((init) =>
      this.context.http.request(url, init, { followRedirects: false, snapshot }),
    );
  }

  /** Zoho documents 204 for an exhausted collection; detail reads remain strict JSON. */
  async list<T>(
    path: string,
    schema: z.ZodType<T>,
    query: Record<string, string> = {},
    snapshot?: ImportSnapshotScope,
  ): Promise<T> {
    const response = await this.request(path, query, snapshot);
    let decoded: unknown;
    try {
      decoded =
        response.status === 204
          ? { data: [] }
          : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
    } catch (error) {
      if (error instanceof SyntaxError || isInvalidUtf8(error))
        throw new ConnectorError('invalid-response');
      throw error;
    }
    const parsed = schema.safeParse(decoded);
    if (!parsed.success) throw new ConnectorError('invalid-response');
    return parsed.data;
  }

  /** A vendor link may locate only the exact parent resource being imported. */
  resource(raw: string, path: string): string {
    const url = new URL(this.url(raw));
    if (
      url.pathname !== path ||
      [...url.searchParams.keys()].some((key) => key !== 'orgId') ||
      url.searchParams.getAll('orgId').length > 1 ||
      (url.searchParams.has('orgId') && url.searchParams.get('orgId') !== this.credentials.orgId)
    )
      throw new ConnectorError('invalid-response');
    return url.href;
  }

  articleResource(raw: string, path: string): string {
    const url = new URL(this.url(raw));
    const inline = url.searchParams.getAll('inline');
    if (inline.length > 1 || (inline.length === 1 && !['true', 'false'].includes(inline[0] ?? '')))
      throw new ConnectorError('invalid-response');
    url.searchParams.delete('inline');
    this.resource(url.href, path);
    if (inline[0] !== undefined) url.searchParams.set('inline', inline[0]);
    return url.href;
  }

  /** Legacy display addresses may be rewritten, but never receive an authenticated request. */
  articleDisplayAlias(raw: string, path: string): string {
    if (!URL.canParse(raw)) throw new ConnectorError('invalid-response');
    const url = new URL(raw);
    if (url.origin !== this.origin || url.username || url.password || url.hash)
      throw new ConnectorError('invalid-response');
    if (url.pathname !== '/support/DocsDisplay') return this.articleResource(raw, path);
    const allowed = new Set(['attachId', 'action', 'zgId', 'entityId']);
    if (
      [...url.searchParams.keys()].some(
        (key) => !allowed.has(key) || url.searchParams.getAll(key).length !== 1,
      ) ||
      !['view', 'download'].includes(url.searchParams.get('action') ?? '') ||
      !url.searchParams.get('attachId') ||
      !url.searchParams.get('zgId') ||
      !url.searchParams.get('entityId')
    )
      throw new ConnectorError('invalid-response');
    return url.href;
  }

  private async authorized<T>(perform: (init: SafeFetchInit) => Promise<T>): Promise<T> {
    const token = await this.oauth.accessToken();
    const request = (value: string) =>
      perform({
        signal: this.context.signal,
        headers: { authorization: `Zoho-oauthtoken ${value}`, orgId: this.credentials.orgId },
      });
    try {
      return await request(token);
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.status !== 401) throw error;
      this.oauth.invalidate(token);
      return request(await this.oauth.accessToken());
    }
  }

  async account(): Promise<string> {
    const response = await this.json(
      '/api/v1/organizations',
      z.object({
        data: z
          .array(
            z.object({
              id: z.string().regex(/^[1-9]\d*$/),
              companyName: z.string(),
            }),
          )
          .max(1000),
      }),
    );
    if (!response.data.some((org) => org.id === this.credentials.orgId))
      throw new ConnectorError('credentials-refused');
    return `${this.credentials.region}:${this.credentials.orgId}`;
  }

  async refuseTicketWindow(): Promise<never> {
    await this.context.log({
      level: 'error',
      entity: 'ticket',
      message: 'import.zoho.timestamp-window-exhausted',
    });
    throw new ConnectorError('invalid-response');
  }

  async refuseArchiveWindow(departmentId: string): Promise<never> {
    await this.context.log({
      level: 'error',
      entity: 'ticket',
      externalId: departmentId,
      message: 'import.zoho.archive-window-exhausted',
    });
    throw new ConnectorError('invalid-response');
  }

  warnHistory(
    message:
      | 'import.message.identity-unavailable'
      | 'import.message.unsent-thread'
      | 'import.zoho.full-content-format-inferred'
      | 'import.zoho.original-mail-unavailable'
      | 'import.zoho.mail-date-unparsed',
    externalId: string,
  ): Promise<void> {
    return this.context.log({ level: 'warning', entity: 'message', message, externalId });
  }
  async refuseFullContent(externalId: string): Promise<never> {
    await this.context.log({
      level: 'error',
      entity: 'message',
      message: 'import.zoho.full-content-unsupported',
      externalId,
    });
    throw new ConnectorError('invalid-response');
  }
  async refuseHistoryPage(ticketId: string): Promise<never> {
    await this.context.log({
      level: 'error',
      entity: 'message',
      externalId: ticketId,
      message: 'import.zoho.history-page-changed',
    });
    throw new ConnectorError('invalid-response');
  }
  warnDescriptionFallback(ticketId: string): Promise<void> {
    return this.context.log({
      level: 'warning',
      entity: 'message',
      externalId: `description:${ticketId}`,
      message: 'import.zoho.description-fallback',
    });
  }
  warnAttachmentRefresh(externalId: string): Promise<void> {
    return this.context.log({
      level: 'warning',
      entity: 'attachment',
      externalId,
      message: 'import.attachment.expired',
    });
  }
  warnArticleFileEnvelope(externalId: string): Promise<void> {
    return this.context.log({
      level: 'warning',
      entity: 'article',
      externalId,
      message: 'import.zoho.article-files-envelope-inferred',
    });
  }
  warnInactiveProfile(entity: 'contact' | 'organization', externalId: string): Promise<void> {
    return this.context.log({
      level: 'warning',
      entity,
      externalId,
      message: 'import.profile.inactive-source',
    });
  }
  warnFieldSemantics(externalId: string): Promise<void> {
    return this.context.log({
      level: 'warning',
      entity: 'field',
      externalId,
      message: 'import.field.unsupported-semantics',
    });
  }
  warnKnowledge(
    message: 'import.knowledge.locale-unsupported' | 'import.knowledge.readership-restricted',
    entity: 'category' | 'section' | 'article',
    externalId: string,
  ): Promise<void> {
    return this.context.log({ level: 'warning', entity, externalId, message });
  }
  warnCsat(
    message:
      | 'import.csat.timestamp-inferred'
      | 'import.csat.scale-normalized'
      | 'import.csat.rating-unmapped',
    externalId?: string,
  ): Promise<void> {
    return this.context.log({
      level: 'warning',
      entity: 'csat',
      message,
      ...(externalId ? { externalId } : {}),
    });
  }
}
