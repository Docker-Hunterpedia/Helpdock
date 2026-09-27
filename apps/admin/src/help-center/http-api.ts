import {
  type HcArticle,
  type HcArticleCreateRequest,
  type HcArticleUpdateRequest,
  type HcCategory,
  type HcCategoryCreateRequest,
  type HcCategoryUpdateRequest,
  type HcInsights,
  type HcInsightsQuery,
  type HcLocale,
  type HcMedia,
  type HcMediaPresignRequest,
  type HcMediaPresignResponse,
  type HcReorderRequest,
  type HcSection,
  type HcSectionCreateRequest,
  type HcSectionUpdateRequest,
  type HcSettings,
  type HcStructure,
  type HcVersionSaveRequest,
  type HcVersionStatusRequest,
  type HcVisibility,
  hcArticleSchema,
  hcCategorySchema,
  hcInsightsSchema,
  hcMediaPresignResponseSchema,
  hcMediaSchema,
  hcSectionSchema,
  hcSettingsSchema,
  hcStructureSchema,
} from '@helpdock/schemas';
import { AuthError } from '../auth/api.js';
import { HttpTransport } from '../auth/http-transport.js';
import type { HelpCenterApi } from './api.js';

/**
 * The real help center service. It shares its {@link HttpTransport} with the
 * other adapters, and parses every response through the schema the api
 * declared it with.
 */
export class HttpHelpCenterApi implements HelpCenterApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  #path(brandId: string, suffix: string): string {
    return `/brands/${encodeURIComponent(brandId)}/help-center${suffix}`;
  }

  async #call<T>(
    schema: { parse(value: unknown): T },
    method: string,
    brandId: string,
    suffix: string,
    body?: unknown,
  ): Promise<T> {
    return schema.parse(await this.#transport.request(method, this.#path(brandId, suffix), body));
  }

  structure(brandId: string): Promise<HcStructure> {
    return this.#call(hcStructureSchema, 'GET', brandId, '/structure');
  }

  createCategory(brandId: string, request: HcCategoryCreateRequest): Promise<HcCategory> {
    return this.#call(hcCategorySchema, 'POST', brandId, '/categories', request);
  }

  updateCategory(
    brandId: string,
    id: string,
    request: HcCategoryUpdateRequest,
  ): Promise<HcCategory> {
    return this.#call(hcCategorySchema, 'PATCH', brandId, `/categories/${id}`, request);
  }

  async deleteCategory(brandId: string, id: string): Promise<void> {
    await this.#transport.request('DELETE', this.#path(brandId, `/categories/${id}`));
  }

  createSection(brandId: string, request: HcSectionCreateRequest): Promise<HcSection> {
    return this.#call(hcSectionSchema, 'POST', brandId, '/sections', request);
  }

  updateSection(brandId: string, id: string, request: HcSectionUpdateRequest): Promise<HcSection> {
    return this.#call(hcSectionSchema, 'PATCH', brandId, `/sections/${id}`, request);
  }

  async deleteSection(brandId: string, id: string): Promise<void> {
    await this.#transport.request('DELETE', this.#path(brandId, `/sections/${id}`));
  }

  reorder(
    brandId: string,
    kind: 'categories' | 'sections' | 'articles',
    request: HcReorderRequest,
  ): Promise<HcStructure> {
    return this.#call(hcStructureSchema, 'POST', brandId, `/${kind}/reorder`, request);
  }

  article(brandId: string, id: string): Promise<HcArticle> {
    return this.#call(hcArticleSchema, 'GET', brandId, `/articles/${id}`);
  }

  createArticle(brandId: string, request: HcArticleCreateRequest): Promise<HcArticle> {
    return this.#call(hcArticleSchema, 'POST', brandId, '/articles', request);
  }

  updateArticle(brandId: string, id: string, request: HcArticleUpdateRequest): Promise<HcArticle> {
    return this.#call(hcArticleSchema, 'PATCH', brandId, `/articles/${id}`, request);
  }

  async deleteArticle(brandId: string, id: string): Promise<void> {
    await this.#transport.request('DELETE', this.#path(brandId, `/articles/${id}`));
  }

  saveVersion(
    brandId: string,
    id: string,
    locale: HcLocale,
    request: HcVersionSaveRequest,
  ): Promise<HcArticle> {
    return this.#call(
      hcArticleSchema,
      'PUT',
      brandId,
      `/articles/${id}/versions/${locale}`,
      request,
    );
  }

  setStatus(
    brandId: string,
    id: string,
    locale: HcLocale,
    request: HcVersionStatusRequest,
  ): Promise<HcArticle> {
    return this.#call(
      hcArticleSchema,
      'PUT',
      brandId,
      `/articles/${id}/versions/${locale}/status`,
      request,
    );
  }

  setVisibility(
    brandId: string,
    id: string,
    locale: HcLocale,
    visibility: HcVisibility,
  ): Promise<HcArticle> {
    return this.#call(
      hcArticleSchema,
      'PUT',
      brandId,
      `/articles/${id}/versions/${locale}/visibility`,
      { visibility },
    );
  }

  settings(brandId: string): Promise<HcSettings> {
    return this.#call(hcSettingsSchema, 'GET', brandId, '/settings');
  }

  updateSettings(brandId: string, settings: HcSettings): Promise<HcSettings> {
    return this.#call(hcSettingsSchema, 'PUT', brandId, '/settings', settings);
  }

  presignImage(brandId: string, request: HcMediaPresignRequest): Promise<HcMediaPresignResponse> {
    return this.#call(hcMediaPresignResponseSchema, 'POST', brandId, '/media/presign', request);
  }

  async uploadImage(upload: HcMediaPresignResponse, file: Blob): Promise<void> {
    const response = await fetch(upload.url, {
      method: 'PUT',
      headers: upload.headers,
      body: file,
    });
    if (!response.ok) {
      throw new AuthError('unavailable');
    }
  }

  confirmImage(brandId: string, mediaId: string): Promise<HcMedia> {
    return this.#call(hcMediaSchema, 'POST', brandId, `/media/${mediaId}/confirm`);
  }

  image(brandId: string, mediaId: string): Promise<HcMedia> {
    return this.#call(hcMediaSchema, 'GET', brandId, `/media/${mediaId}`);
  }

  insights(brandId: string, query: HcInsightsQuery): Promise<HcInsights> {
    const params = new URLSearchParams({ days: String(query.days), sort: query.sort });
    if (query.locale !== undefined) {
      params.set('locale', query.locale);
    }
    return this.#call(hcInsightsSchema, 'GET', brandId, `/insights?${params.toString()}`);
  }
}
