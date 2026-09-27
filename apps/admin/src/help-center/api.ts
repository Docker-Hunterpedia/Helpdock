import type {
  HcArticle,
  HcArticleCreateRequest,
  HcArticleUpdateRequest,
  HcCategory,
  HcCategoryCreateRequest,
  HcCategoryUpdateRequest,
  HcInsights,
  HcInsightsQuery,
  HcLocale,
  HcMedia,
  HcMediaPresignRequest,
  HcMediaPresignResponse,
  HcRefusal,
  HcReorderRequest,
  HcSection,
  HcSectionCreateRequest,
  HcSectionUpdateRequest,
  HcSettings,
  HcStructure,
  HcVersionSaveRequest,
  HcVersionStatusRequest,
  HcVisibility,
} from '@helpdock/schemas';

/**
 * Everything `Admin/HelpCenter` and `Admin/HelpCenter-Editor` need (M5-01,
 * M5-02, M5-09), and nothing else. `MockHelpCenterApi` is the fixture the unit
 * tests and the mock Playwright projects run against; `HttpHelpCenterApi` is
 * the real service.
 */
export interface HelpCenterApi {
  structure(brandId: string): Promise<HcStructure>;
  createCategory(brandId: string, request: HcCategoryCreateRequest): Promise<HcCategory>;
  updateCategory(
    brandId: string,
    id: string,
    request: HcCategoryUpdateRequest,
  ): Promise<HcCategory>;
  deleteCategory(brandId: string, id: string): Promise<void>;
  createSection(brandId: string, request: HcSectionCreateRequest): Promise<HcSection>;
  updateSection(brandId: string, id: string, request: HcSectionUpdateRequest): Promise<HcSection>;
  deleteSection(brandId: string, id: string): Promise<void>;
  reorder(
    brandId: string,
    kind: 'categories' | 'sections' | 'articles',
    request: HcReorderRequest,
  ): Promise<HcStructure>;
  article(brandId: string, id: string): Promise<HcArticle>;
  createArticle(brandId: string, request: HcArticleCreateRequest): Promise<HcArticle>;
  updateArticle(brandId: string, id: string, request: HcArticleUpdateRequest): Promise<HcArticle>;
  deleteArticle(brandId: string, id: string): Promise<void>;
  saveVersion(
    brandId: string,
    id: string,
    locale: HcLocale,
    request: HcVersionSaveRequest,
  ): Promise<HcArticle>;
  setStatus(
    brandId: string,
    id: string,
    locale: HcLocale,
    request: HcVersionStatusRequest,
  ): Promise<HcArticle>;
  setVisibility(
    brandId: string,
    id: string,
    locale: HcLocale,
    visibility: HcVisibility,
  ): Promise<HcArticle>;
  settings(brandId: string): Promise<HcSettings>;
  updateSettings(brandId: string, settings: HcSettings): Promise<HcSettings>;
  presignImage(brandId: string, request: HcMediaPresignRequest): Promise<HcMediaPresignResponse>;
  /** PUTs the bytes to the presigned URL. The real one talks to the bucket, not the api. */
  uploadImage(upload: HcMediaPresignResponse, file: Blob): Promise<void>;
  confirmImage(brandId: string, mediaId: string): Promise<HcMedia>;
  /** M5-08: Help center › Insights. */
  insights(brandId: string, query: HcInsightsQuery): Promise<HcInsights>;
  image(brandId: string, mediaId: string): Promise<HcMedia>;
}

/** Every cache key the help center screens use. */
export const helpCenterKeys = {
  all: (brandId: string) => ['help-center', brandId] as const,
  structure: (brandId: string) => ['help-center', brandId, 'structure'] as const,
  article: (brandId: string, id: string) => ['help-center', brandId, 'article', id] as const,
  settings: (brandId: string) => ['help-center', brandId, 'settings'] as const,
  insights: (brandId: string, query: HcInsightsQuery) =>
    ['help-center', brandId, 'insights', query.days, query.locale ?? 'all', query.sort] as const,
};

/** A change the api refused by a rule, with the reason the screen turns into a sentence. */
export class HelpCenterError extends Error {
  readonly reason: HcRefusal;

  constructor(reason: HcRefusal) {
    super(`help center: ${reason}`);
    this.name = 'HelpCenterError';
    this.reason = reason;
  }
}

export const isHelpCenterError = (error: unknown): error is HelpCenterError =>
  error instanceof HelpCenterError;
