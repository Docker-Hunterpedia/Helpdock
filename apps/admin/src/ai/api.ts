import type {
  AiDefaultModelUpdate,
  AiModelList,
  AiProvidersOverview,
  AiProviderUpsert,
  AiProviderView,
  AiRefusal,
  BrandAiCallsPage,
  BrandAiModesUpdate,
  BrandAiPromptUpdate,
  BrandAiSettings,
  BrandAiSettingsUpdate,
  EmbeddingSettingsUpdate,
  EmbeddingSettingsView,
  TranscriptionSettingsUpdate,
  TranscriptionSettingsView,
} from '@helpdock/schemas';

/**
 * Everything `Admin/AI` and the wizard's AI step need (M7-10): the install's
 * providers, default model, transcription endpoint and embedding model, and a
 * brand's assistant settings and activity. `MockAiApi` is the fixture the unit
 * tests and the mock Playwright projects run against; `HttpAiApi` is the real
 * service. Refusals cross as an {@link AiError} carrying the api's reason.
 */
export interface AiApi {
  providers(): Promise<AiProvidersOverview>;
  saveProvider(providerId: string, request: AiProviderUpsert): Promise<AiProviderView>;
  removeProvider(providerId: string): Promise<void>;
  models(providerId: string): Promise<AiModelList>;
  setDefaultModel(request: AiDefaultModelUpdate): Promise<AiProvidersOverview>;

  transcription(): Promise<TranscriptionSettingsView>;
  saveTranscription(request: TranscriptionSettingsUpdate): Promise<TranscriptionSettingsView>;

  embedding(): Promise<EmbeddingSettingsView>;
  saveEmbedding(request: EmbeddingSettingsUpdate): Promise<EmbeddingSettingsView>;

  brandSettings(brandId: string): Promise<BrandAiSettings>;
  saveBrandSettings(brandId: string, request: BrandAiSettingsUpdate): Promise<BrandAiSettings>;
  saveModes(brandId: string, request: BrandAiModesUpdate): Promise<BrandAiSettings>;
  savePrompt(brandId: string, request: BrandAiPromptUpdate): Promise<BrandAiSettings>;
  calls(brandId: string, cursor?: string): Promise<BrandAiCallsPage>;
}

export class AiError extends Error {
  readonly reason: AiRefusal;

  constructor(reason: AiRefusal) {
    super(`ai: ${reason}`);
    this.name = 'AiError';
    this.reason = reason;
  }
}

export const isAiError = (error: unknown): error is AiError => error instanceof AiError;

export const aiKeys = {
  providers: ['ai', 'providers'] as const,
  models: (providerId: string) => ['ai', 'providers', providerId, 'models'] as const,
  transcription: ['ai', 'transcription'] as const,
  embedding: ['ai', 'embedding'] as const,
  brand: (brandId: string) => ['ai', 'brand', brandId] as const,
  calls: (brandId: string) => ['ai', 'brand', brandId, 'calls'] as const,
};
