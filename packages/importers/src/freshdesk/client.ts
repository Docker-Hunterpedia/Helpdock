import { z } from 'zod';
import type { ConnectorContext } from '../connector.js';
import { ConnectorError } from '../errors.js';
import { type FreshdeskCredentials, freshdeskCredentialsSchema } from './contracts.js';

export class FreshdeskClient {
  readonly origin: string;
  private readonly authorization: string;
  private readonly authors = new Map<number, 'agent' | 'customer'>();

  constructor(
    private readonly context: ConnectorContext<FreshdeskCredentials>,
    apiRoot?: string,
  ) {
    const credentials = freshdeskCredentialsSchema.parse(context.credentials);
    const address = new URL(apiRoot ?? `https://${credentials.domain}.freshdesk.com`);
    if (address.username || address.password || !['https:', 'http:'].includes(address.protocol))
      throw new ConnectorError('invalid-response');
    this.origin = address.origin;
    this.authorization = `Basic ${Buffer.from(`${credentials.apiKey}:X`).toString('base64')}`;
  }

  url(path: string, query: Record<string, string> = {}): string {
    const address = new URL(path, this.origin);
    if (address.origin !== this.origin || address.username || address.password)
      throw new ConnectorError('invalid-response');
    for (const [key, value] of Object.entries(query)) address.searchParams.set(key, value);
    return address.href;
  }

  async json<T>(
    path: string,
    schema: z.ZodType<T>,
    query: Record<string, string> = {},
  ): Promise<T> {
    this.context.signal.throwIfAborted();
    return this.context.http.json(this.url(path, query), schema, {
      signal: this.context.signal,
      headers: { authorization: this.authorization },
    });
  }

  async refuseTimestampWindow(): Promise<never> {
    await this.context.log({
      level: 'error',
      entity: 'ticket',
      message: 'import.freshdesk.timestamp-window-exhausted',
    });
    throw new ConnectorError('invalid-response');
  }

  async authorKind(id: number): Promise<'agent' | 'customer'> {
    const cached = this.authors.get(id);
    if (cached) return cached;
    let kind: 'agent' | 'customer';
    const identity = z.object({ id: z.number().int().positive() });
    try {
      const author = await this.json(`/api/v2/agents/${id}`, identity);
      if (author.id !== id) throw new ConnectorError('invalid-response');
      kind = 'agent';
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.code !== 'record-unavailable') throw error;
      const author = await this.json(`/api/v2/contacts/${id}`, identity);
      if (author.id !== id) throw new ConnectorError('invalid-response');
      kind = 'customer';
    }
    if (this.authors.size >= 128) this.authors.clear();
    this.authors.set(id, kind);
    return kind;
  }

  warnOutboundAuthor(id: number): Promise<void> {
    return this.context.log({
      level: 'warning',
      entity: 'message',
      externalId: `ticket:${id}:description`,
      message: 'import.message.author-unavailable',
    });
  }

  warnScaleNormalization(): Promise<void> {
    return this.context.log({
      level: 'warning',
      entity: 'csat',
      message: 'import.csat.scale-normalized',
    });
  }

  warnUnmappedRating(): Promise<void> {
    return this.context.log({
      level: 'warning',
      entity: 'csat',
      message: 'import.csat.rating-unmapped',
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

  warnTranslation(entity: 'category' | 'section' | 'article', externalId: string): Promise<void> {
    return this.context.log({
      level: 'warning',
      entity,
      externalId,
      message: 'import.record-unavailable',
    });
  }

  warnReadership(externalId: string): Promise<void> {
    return this.context.log({
      level: 'warning',
      entity: 'article',
      externalId,
      message: 'import.knowledge.readership-restricted',
    });
  }

  async refuseKnowledgeLocales(): Promise<never> {
    await this.context.log({
      level: 'error',
      entity: 'article',
      message: 'import.knowledge.locale-unsupported',
    });
    throw new ConnectorError('invalid-response');
  }

  async page<T>(
    path: string,
    schema: z.ZodType<T>,
    query: Record<string, string> & { page: string },
  ) {
    this.context.signal.throwIfAborted();
    const current = new URL(this.url(path, query));
    const result = await this.context.http.jsonResponse(current.href, z.array(schema).max(100), {
      signal: this.context.signal,
      headers: { authorization: this.authorization },
    });
    const rawLink = result.headers.link;
    const link = Array.isArray(rawLink) ? rawLink.join(',') : rawLink;
    if (!link) return { rows: result.data, nextPage: null };
    const parts = link.split(/,\s*(?=<)/);
    let nextPage: number | null = null;
    for (const part of parts) {
      if (!/;\s*rel\s*=\s*"?next"?(?:\s*;|\s*$)/i.test(part)) continue;
      const match = /^\s*<([^>]+)>/.exec(part);
      if (!match?.[1] || nextPage !== null) throw new ConnectorError('invalid-response');
      if (!URL.canParse(match[1], this.origin)) throw new ConnectorError('invalid-response');
      const next = new URL(match[1], this.origin);
      const page = Number(next.searchParams.get('page'));
      if (
        next.origin !== current.origin ||
        next.pathname !== current.pathname ||
        next.username ||
        next.password ||
        next.hash ||
        !Number.isSafeInteger(page) ||
        page !== Number(query.page) + 1
      )
        throw new ConnectorError('invalid-response');
      // Carry only a checked page number forward; vendor links cannot replace filters or leak credentials.
      nextPage = page;
    }
    if (nextPage !== null && result.data.length === 0) throw new ConnectorError('invalid-response');
    return { rows: result.data, nextPage };
  }

  async tokenPage<T>(path: string, schema: z.ZodType<T>, token: string | null) {
    const query = { per_page: '100', ...(token === null ? {} : { next_token: token }) };
    const current = new URL(this.url(path, query));
    const result = await this.json(
      path,
      z.object({
        data: z.array(schema).max(100),
        paging: z.object({ next: z.url().nullable(), previous: z.url().nullable() }),
      }),
      query,
    );
    if (result.paging.next === null) return { rows: result.data, nextToken: null };
    const next = new URL(result.paging.next);
    const nextToken = next.searchParams.get('next_token');
    if (
      next.origin !== current.origin ||
      next.pathname !== current.pathname ||
      next.username ||
      next.password ||
      next.hash ||
      !nextToken ||
      nextToken.length > 4096 ||
      nextToken === token ||
      !result.data.length ||
      [...next.searchParams.keys()].some((key) => !['per_page', 'next_token'].includes(key)) ||
      next.searchParams.getAll('next_token').length !== 1 ||
      next.searchParams.getAll('per_page').length > 1 ||
      (next.searchParams.has('per_page') && next.searchParams.get('per_page') !== '100')
    )
      throw new ConnectorError('invalid-response');
    return { rows: result.data, nextToken };
  }
}
