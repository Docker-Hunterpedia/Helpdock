import {
  type AiDefaultModelUpdate,
  type AiModelList,
  type AiProvidersOverview,
  type AiProviderUpsert,
  type AiProviderView,
  aiModelListSchema,
  aiProvidersOverviewSchema,
  aiProviderViewSchema,
  type BrandAiCallsPage,
  type BrandAiModesUpdate,
  type BrandAiPromptUpdate,
  type BrandAiSettings,
  type BrandAiSettingsUpdate,
  brandAiCallsPageSchema,
  brandAiSettingsSchema,
  type EmbeddingSettingsUpdate,
  type EmbeddingSettingsView,
  embeddingSettingsViewSchema,
  type TranscriptionSettingsUpdate,
  type TranscriptionSettingsView,
  transcriptionSettingsViewSchema,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import type { AiApi } from './api.js';

const INSTALL = '/install/ai';

/**
 * The real AI service. It shares the app's {@link HttpTransport}, so the
 * access token and its refresh are the ones every other screen uses, and
 * parses every answer through the schema the api declared it with.
 */
export class HttpAiApi implements AiApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async providers(): Promise<AiProvidersOverview> {
    return aiProvidersOverviewSchema.parse(
      await this.#transport.request('GET', `${INSTALL}/providers`),
    );
  }

  async saveProvider(providerId: string, request: AiProviderUpsert): Promise<AiProviderView> {
    return aiProviderViewSchema.parse(
      await this.#transport.request('PUT', this.#provider(providerId), request),
    );
  }

  async removeProvider(providerId: string): Promise<void> {
    await this.#transport.request('DELETE', this.#provider(providerId));
  }

  async models(providerId: string): Promise<AiModelList> {
    return aiModelListSchema.parse(
      await this.#transport.request('GET', `${this.#provider(providerId)}/models`),
    );
  }

  async setDefaultModel(request: AiDefaultModelUpdate): Promise<AiProvidersOverview> {
    return aiProvidersOverviewSchema.parse(
      await this.#transport.request('PUT', `${INSTALL}/default-model`, request),
    );
  }

  async transcription(): Promise<TranscriptionSettingsView> {
    return transcriptionSettingsViewSchema.parse(
      await this.#transport.request('GET', `${INSTALL}/transcription`),
    );
  }

  async saveTranscription(
    request: TranscriptionSettingsUpdate,
  ): Promise<TranscriptionSettingsView> {
    return transcriptionSettingsViewSchema.parse(
      await this.#transport.request('PUT', `${INSTALL}/transcription`, request),
    );
  }

  async embedding(): Promise<EmbeddingSettingsView> {
    return embeddingSettingsViewSchema.parse(
      await this.#transport.request('GET', `${INSTALL}/embedding`),
    );
  }

  async saveEmbedding(request: EmbeddingSettingsUpdate): Promise<EmbeddingSettingsView> {
    return embeddingSettingsViewSchema.parse(
      await this.#transport.request('PUT', `${INSTALL}/embedding`, request),
    );
  }

  async brandSettings(brandId: string): Promise<BrandAiSettings> {
    return brandAiSettingsSchema.parse(
      await this.#transport.request('GET', `${this.#brand(brandId)}/settings`),
    );
  }

  async saveBrandSettings(
    brandId: string,
    request: BrandAiSettingsUpdate,
  ): Promise<BrandAiSettings> {
    return brandAiSettingsSchema.parse(
      await this.#transport.request('PUT', `${this.#brand(brandId)}/settings`, request),
    );
  }

  async saveModes(brandId: string, request: BrandAiModesUpdate): Promise<BrandAiSettings> {
    return brandAiSettingsSchema.parse(
      await this.#transport.request('PUT', `${this.#brand(brandId)}/modes`, request),
    );
  }

  async savePrompt(brandId: string, request: BrandAiPromptUpdate): Promise<BrandAiSettings> {
    return brandAiSettingsSchema.parse(
      await this.#transport.request('PUT', `${this.#brand(brandId)}/prompt`, request),
    );
  }

  async calls(brandId: string, cursor?: string): Promise<BrandAiCallsPage> {
    const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    return brandAiCallsPageSchema.parse(
      await this.#transport.request('GET', `${this.#brand(brandId)}/calls${query}`),
    );
  }

  #provider(providerId: string): string {
    return `${INSTALL}/providers/${encodeURIComponent(providerId)}`;
  }

  #brand(brandId: string): string {
    return `/brands/${encodeURIComponent(brandId)}/ai`;
  }
}
