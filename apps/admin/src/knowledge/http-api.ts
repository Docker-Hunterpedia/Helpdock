import {
  type KnowledgeBrowse,
  type KnowledgeLog,
  type KnowledgeOAuthProvider,
  type KnowledgeSourceCreate,
  type KnowledgeSourceList,
  type KnowledgeSourceUpdate,
  type KnowledgeSourceView,
  type KnowledgeVisibility,
  knowledgeBrowseSchema,
  knowledgeFilePresignResponseSchema,
  knowledgeLogSchema,
  knowledgeOAuthStartSchema,
  knowledgeSourceListSchema,
  knowledgeSourceViewSchema,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import type { KnowledgeApi } from './api.js';

/** Thrown when storage refuses the presigned upload itself. */
export class KnowledgeUploadError extends Error {
  constructor(status: number) {
    super(`knowledge: storage answered ${String(status)}`);
    this.name = 'KnowledgeUploadError';
  }
}

/**
 * The real knowledge service. It shares the app's {@link HttpTransport} and
 * parses every answer through the schema the api declared it with. A file
 * goes to storage directly on the presigned URL, with the presigned headers
 * sent verbatim, and is confirmed after.
 */
export class HttpKnowledgeApi implements KnowledgeApi {
  readonly #transport: HttpTransport;
  readonly #put: typeof fetch;

  constructor(transport: HttpTransport = new HttpTransport(), put: typeof fetch = fetch) {
    this.#transport = transport;
    this.#put = put;
  }

  async sources(brandId: string): Promise<KnowledgeSourceList> {
    return knowledgeSourceListSchema.parse(
      await this.#transport.request('GET', `${this.#base(brandId)}/sources`),
    );
  }

  async createSource(
    brandId: string,
    request: KnowledgeSourceCreate,
  ): Promise<KnowledgeSourceView> {
    return knowledgeSourceViewSchema.parse(
      await this.#transport.request('POST', `${this.#base(brandId)}/sources`, request),
    );
  }

  async updateSource(
    brandId: string,
    sourceId: string,
    request: KnowledgeSourceUpdate,
  ): Promise<KnowledgeSourceView> {
    return knowledgeSourceViewSchema.parse(
      await this.#transport.request('PATCH', this.#source(brandId, sourceId), request),
    );
  }

  async removeSource(brandId: string, sourceId: string): Promise<void> {
    await this.#transport.request('DELETE', this.#source(brandId, sourceId));
  }

  async syncNow(brandId: string, sourceId: string): Promise<KnowledgeSourceView> {
    return knowledgeSourceViewSchema.parse(
      await this.#transport.request('POST', `${this.#source(brandId, sourceId)}/sync`),
    );
  }

  async log(brandId: string, sourceId: string, level: 'all' | 'warn'): Promise<KnowledgeLog> {
    return knowledgeLogSchema.parse(
      await this.#transport.request('GET', `${this.#source(brandId, sourceId)}/log?level=${level}`),
    );
  }

  async browse(brandId: string, sourceId: string, query: string): Promise<KnowledgeBrowse> {
    return knowledgeBrowseSchema.parse(
      await this.#transport.request(
        'GET',
        `${this.#source(brandId, sourceId)}/browse?q=${encodeURIComponent(query)}`,
      ),
    );
  }

  async uploadFile(
    brandId: string,
    file: File,
    visibility: KnowledgeVisibility,
  ): Promise<KnowledgeSourceView> {
    const presigned = knowledgeFilePresignResponseSchema.parse(
      await this.#transport.request('POST', `${this.#base(brandId)}/files`, {
        fileName: file.name,
        mime: file.type,
        size: file.size,
        visibility,
      }),
    );
    const stored = await this.#put(presigned.url, {
      method: 'PUT',
      headers: presigned.headers,
      body: file,
    });
    if (!stored.ok) {
      throw new KnowledgeUploadError(stored.status);
    }
    return knowledgeSourceViewSchema.parse(
      await this.#transport.request('POST', `${this.#source(brandId, presigned.sourceId)}/confirm`),
    );
  }

  async oauthStart(
    brandId: string,
    sourceId: string,
    provider: KnowledgeOAuthProvider,
  ): Promise<string> {
    return knowledgeOAuthStartSchema.parse(
      await this.#transport.request('POST', `${this.#source(brandId, sourceId)}/oauth/${provider}`),
    ).url;
  }

  #base(brandId: string): string {
    return `/brands/${encodeURIComponent(brandId)}/knowledge`;
  }

  #source(brandId: string, sourceId: string): string {
    return `${this.#base(brandId)}/sources/${encodeURIComponent(sourceId)}`;
  }
}
