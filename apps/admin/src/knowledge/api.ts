import type {
  KnowledgeBrowse,
  KnowledgeLog,
  KnowledgeOAuthProvider,
  KnowledgeRefusal,
  KnowledgeSourceCreate,
  KnowledgeSourceList,
  KnowledgeSourceUpdate,
  KnowledgeSourceView,
  KnowledgeVisibility,
} from '@helpdock/schemas';

/**
 * Everything AI › Knowledge needs (M7-10 on M7-03's api). `MockKnowledgeApi`
 * is the fixture the unit tests and the mock Playwright projects run against;
 * `HttpKnowledgeApi` is the real service. Refusals cross as a
 * {@link KnowledgeError} carrying the api's reason.
 */
export interface KnowledgeApi {
  sources(brandId: string): Promise<KnowledgeSourceList>;
  createSource(brandId: string, request: KnowledgeSourceCreate): Promise<KnowledgeSourceView>;
  updateSource(
    brandId: string,
    sourceId: string,
    request: KnowledgeSourceUpdate,
  ): Promise<KnowledgeSourceView>;
  removeSource(brandId: string, sourceId: string): Promise<void>;
  syncNow(brandId: string, sourceId: string): Promise<KnowledgeSourceView>;
  log(brandId: string, sourceId: string, level: 'all' | 'warn'): Promise<KnowledgeLog>;
  browse(brandId: string, sourceId: string, query: string): Promise<KnowledgeBrowse>;
  /** Presign, put the bytes to storage, confirm: one file source per file. */
  uploadFile(
    brandId: string,
    file: File,
    visibility: KnowledgeVisibility,
  ): Promise<KnowledgeSourceView>;
  /** The provider's consent page, which the browser is sent to. */
  oauthStart(brandId: string, sourceId: string, provider: KnowledgeOAuthProvider): Promise<string>;
}

export class KnowledgeError extends Error {
  readonly reason: KnowledgeRefusal;

  constructor(reason: KnowledgeRefusal) {
    super(`knowledge: ${reason}`);
    this.name = 'KnowledgeError';
    this.reason = reason;
  }
}

export const isKnowledgeError = (error: unknown): error is KnowledgeError =>
  error instanceof KnowledgeError;

export const knowledgeKeys = {
  sources: (brandId: string) => ['knowledge', brandId, 'sources'] as const,
  log: (brandId: string, sourceId: string, level: string) =>
    ['knowledge', brandId, 'log', sourceId, level] as const,
  browse: (brandId: string, sourceId: string, query: string) =>
    ['knowledge', brandId, 'browse', sourceId, query] as const,
};
