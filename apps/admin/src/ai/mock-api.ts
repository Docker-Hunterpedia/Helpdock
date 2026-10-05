import {
  type AiCallSummary,
  type AiDefaultModelUpdate,
  type AiModelList,
  type AiProviderKind,
  type AiProvidersOverview,
  type AiProviderUpsert,
  type AiProviderView,
  type BrandAiCallsPage,
  type BrandAiModesUpdate,
  type BrandAiPromptUpdate,
  type BrandAiSettings,
  type BrandAiSettingsUpdate,
  type EmbeddingSettingsUpdate,
  type EmbeddingSettingsView,
  parseAiAssistantModes,
  type TranscriptionSettingsUpdate,
  type TranscriptionSettingsView,
} from '@helpdock/schemas';
import { MOCK_BRANDS } from '../auth/mock-api.js';
import { type AiApi, AiError } from './api.js';

/**
 * The AI fixture: the five providers of `Admin/AI-Providers` (an OpenRouter
 * key the provider rejects among them), an embedding model ready to change, a
 * transcription endpoint pinned by the environment, and the first brand at
 * its monthly hard stop with a page and a half of activity, as
 * `Admin/AI-Assistant` draws it. What it refuses mirrors the api closely
 * enough for the screens' error lines to be exercised; the real rules are the
 * api's and are tested there.
 */

const KINDS: readonly AiProviderKind[] = [
  { id: 'openai', oauth: true, needsBaseUrl: false },
  { id: 'anthropic', oauth: true, needsBaseUrl: false },
  { id: 'google', oauth: true, needsBaseUrl: false },
  { id: 'openrouter', oauth: false, needsBaseUrl: false },
  { id: 'openai-compatible', oauth: false, needsBaseUrl: true },
];

const model = (id: string, contextWindow: number, input: number, output: number) => ({
  id,
  name: id,
  contextWindow,
  maxTokens: 32_768,
  reasoning: false,
  inputPerMillionUsd: input,
  outputPerMillionUsd: output,
});

const MODELS: Readonly<Record<string, AiModelList['models']>> = {
  openai: [
    model('gpt-4.1', 1_047_576, 2, 8),
    model('gpt-4.1-mini', 1_047_576, 0.4, 1.6),
    model('gpt-4o', 128_000, 2.5, 10),
    model('o4-mini', 200_000, 1.1, 4.4),
  ],
  anthropic: [model('claude-sonnet-4-5', 200_000, 3, 15), model('claude-haiku-4-5', 200_000, 1, 5)],
  google: [model('gemini-2.5-pro', 1_048_576, 1.25, 10)],
  local: [model('qwen2.5:14b', 32_768, 0, 0), model('llama3.1:8b', 131_072, 0, 0)],
};

/** Discovery fails for these, as a provider whose key was revoked does. */
const UNREACHABLE = new Set(['openrouter']);

const MOCK_CHUNKS = 4_812;
const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

const view = (
  id: string,
  kind: string,
  label: string,
  authType: AiProviderView['authType'],
  baseUrl: string | null = null,
): AiProviderView => ({
  id,
  kind,
  label,
  baseUrl,
  authType,
  oauthExpiresAt: authType === 'oauth' ? '2026-10-12T09:40:00.000Z' : null,
});

interface StoredProvider {
  view: AiProviderView;
  hasCredential: boolean;
}

const callsFixture = (now: number): AiCallSummary[] => {
  const features = [
    'assist.suggest_reply',
    'autoreply',
    'autoreply',
    'assist.translate',
    'assist.summarize',
    'autoreply',
    'transcribe',
  ];
  return Array.from({ length: 27 }, (_, index) => {
    const feature = features[index % features.length] ?? 'autoreply';
    const refused = index === 1;
    const status: AiCallSummary['status'] = refused ? 'refused' : 'ok';
    return {
      id: `0192c3f0-1a2b-7c3d-8e4f-${(index + 1).toString(16).padStart(12, '0')}`,
      feature,
      model: feature === 'transcribe' ? 'whisper-1' : 'gpt-4.1-mini',
      status,
      tokensIn: refused ? 0 : 2_140 + index * 37,
      tokensOut: refused ? 0 : 310 - index * 3,
      costUsd: refused ? 0 : 0.0014 + index / 10_000,
      createdAt: new Date(now - index * 4 * 60_000).toISOString(),
      ticket: {
        id: `0192c3f0-0000-7000-8000-${(1061 - index).toString(16).padStart(12, '0')}`,
        reference: `HD-${String(1061 - index)}`,
      },
    };
  });
};

const PAGE = 20;

export class MockAiApi implements AiApi {
  readonly #now: () => number;
  readonly #providers = new Map<string, StoredProvider>([
    ['openai', { view: view('openai', 'openai', 'OpenAI', 'apiKey'), hasCredential: true }],
    [
      'anthropic',
      { view: view('anthropic', 'anthropic', 'Anthropic', 'apiKey'), hasCredential: true },
    ],
    ['google', { view: view('google', 'google', 'Google', 'oauth'), hasCredential: true }],
    [
      'openrouter',
      { view: view('openrouter', 'openrouter', 'OpenRouter', 'apiKey'), hasCredential: true },
    ],
    [
      'local',
      {
        view: view('local', 'openai-compatible', 'Local models', 'none', 'http://ollama:11434/v1'),
        hasCredential: false,
      },
    ],
  ]);
  #defaults: AiProvidersOverview['defaults'] = { providerId: 'openai', modelId: 'gpt-4.1-mini' };
  #transcription: TranscriptionSettingsView = {
    endpoint: ENDPOINT,
    model: 'whisper-1',
    hasApiKey: true,
    lockedKeys: ['transcription.endpoint'],
  };
  #embedding: EmbeddingSettingsView;
  readonly #brands = new Map<string, BrandAiSettings>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.#embedding = {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'text-embedding-3-small',
      dims: 1_536,
      pricePerMillionTokens: 0.02,
      hasApiKey: true,
      lockedKeys: [],
      space: {
        status: 'ready',
        activeModel: 'text-embedding-3-small',
        activeDims: 1_536,
        targetModel: 'text-embedding-3-small',
        targetDims: 1_536,
        lastError: null,
        startedAt: '2026-10-02T03:00:00.000Z',
        finishedAt: '2026-10-02T03:12:00.000Z',
        progress: { embedded: MOCK_CHUNKS, total: MOCK_CHUNKS },
      },
    };
  }

  providers(): Promise<AiProvidersOverview> {
    return Promise.resolve({
      providers: [...this.#providers.values()].map((stored) => stored.view),
      kinds: [...KINDS],
      defaults: { ...this.#defaults },
      locked: { providers: false, defaults: false },
    });
  }

  saveProvider(providerId: string, request: AiProviderUpsert): Promise<AiProviderView> {
    const kind = KINDS.find((candidate) => candidate.id === request.kind);
    if (kind === undefined) {
      return Promise.reject(new AiError('unknown-kind'));
    }
    if (request.auth.type === 'oauth' && !kind.oauth) {
      return Promise.reject(new AiError('oauth-unsupported'));
    }
    const existing = this.#providers.get(providerId);
    const sent =
      (request.auth.type === 'apiKey' && request.auth.apiKey !== undefined) ||
      (request.auth.type === 'oauth' && request.auth.credentials !== undefined);
    const kept = existing?.view.authType === request.auth.type && existing.hasCredential;
    if (request.auth.type !== 'none' && !sent && !kept) {
      return Promise.reject(new AiError('credential-required'));
    }
    const saved = view(providerId, request.kind, request.label, request.auth.type, request.baseUrl);
    this.#providers.set(providerId, { view: saved, hasCredential: request.auth.type !== 'none' });
    return Promise.resolve(saved);
  }

  removeProvider(providerId: string): Promise<void> {
    if (!this.#providers.has(providerId)) {
      return Promise.reject(new AiError('unknown-provider'));
    }
    const inUse =
      this.#defaults.providerId === providerId ||
      [...this.#brands.values()].some((brand) => brand.providerId === providerId);
    if (inUse) {
      return Promise.reject(new AiError('provider-in-use'));
    }
    this.#providers.delete(providerId);
    return Promise.resolve();
  }

  models(providerId: string): Promise<AiModelList> {
    const stored = this.#providers.get(providerId);
    if (stored === undefined) {
      return Promise.reject(new AiError('unknown-provider'));
    }
    if (UNREACHABLE.has(providerId)) {
      return Promise.reject(new AiError('discovery-failed'));
    }
    return Promise.resolve({
      models: [...(MODELS[providerId] ?? MODELS[stored.view.kind] ?? [])],
    });
  }

  async setDefaultModel(request: AiDefaultModelUpdate): Promise<AiProvidersOverview> {
    if (!this.#providers.has(request.providerId)) {
      throw new AiError('unknown-provider');
    }
    this.#defaults = { providerId: request.providerId, modelId: request.modelId };
    return this.providers();
  }

  transcription(): Promise<TranscriptionSettingsView> {
    return Promise.resolve({ ...this.#transcription });
  }

  saveTranscription(request: TranscriptionSettingsUpdate): Promise<TranscriptionSettingsView> {
    if (
      request.endpoint !== this.#transcription.endpoint &&
      this.#transcription.lockedKeys.includes('transcription.endpoint')
    ) {
      return Promise.reject(new AiError('locked-by-environment'));
    }
    this.#transcription = {
      ...this.#transcription,
      endpoint: request.endpoint,
      model: request.model,
      hasApiKey:
        request.apiKey === undefined ? this.#transcription.hasApiKey : request.apiKey !== '',
    };
    return this.transcription();
  }

  embedding(): Promise<EmbeddingSettingsView> {
    return Promise.resolve(structuredClone(this.#embedding));
  }

  saveEmbedding(request: EmbeddingSettingsUpdate): Promise<EmbeddingSettingsView> {
    const changes =
      request.model !== this.#embedding.model || request.dims !== this.#embedding.dims;
    if (changes && request.confirmReembed !== true) {
      return Promise.reject(new AiError('reembed-not-confirmed'));
    }
    this.#embedding = {
      ...this.#embedding,
      provider: request.provider,
      baseUrl: request.baseUrl,
      model: request.model,
      dims: request.dims,
      pricePerMillionTokens: request.pricePerMillionTokens,
      hasApiKey: request.apiKey === undefined ? this.#embedding.hasApiKey : request.apiKey !== '',
      space: changes
        ? {
            ...this.#embedding.space,
            status: 'reindexing',
            targetModel: request.model,
            targetDims: request.dims,
            startedAt: new Date(this.#now()).toISOString(),
            finishedAt: null,
            progress: { embedded: 0, total: MOCK_CHUNKS },
          }
        : this.#embedding.space,
    };
    return this.embedding();
  }

  brandSettings(brandId: string): Promise<BrandAiSettings> {
    return Promise.resolve(structuredClone(this.#brand(brandId)));
  }

  saveBrandSettings(brandId: string, request: BrandAiSettingsUpdate): Promise<BrandAiSettings> {
    if (request.providerId !== null && !this.#providers.has(request.providerId)) {
      return Promise.reject(new AiError('unknown-provider'));
    }
    const held = this.#brand(brandId);
    this.#brands.set(brandId, {
      ...held,
      providerId: request.providerId,
      modelId: request.modelId,
      piiRedaction: request.piiRedaction,
      injectionFilter: request.injectionFilter,
      budget: request.budget,
      usage: { ...held.usage, windows: windowsOf(request.budget, held.usage) },
    });
    return this.brandSettings(brandId);
  }

  saveModes(
    brandId: string,
    { aiCountsAsFirstResponse, ...modes }: BrandAiModesUpdate,
  ): Promise<BrandAiSettings> {
    this.#brands.set(brandId, { ...this.#brand(brandId), modes, aiCountsAsFirstResponse });
    return this.brandSettings(brandId);
  }

  savePrompt(brandId: string, request: BrandAiPromptUpdate): Promise<BrandAiSettings> {
    const held = this.#brand(brandId);
    this.#brands.set(brandId, {
      ...held,
      systemPrompt: request.systemPrompt,
      systemPromptAr: request.systemPromptAr ?? held.systemPromptAr,
    });
    return this.brandSettings(brandId);
  }

  calls(_brandId: string, cursor?: string): Promise<BrandAiCallsPage> {
    const all = callsFixture(this.#now());
    const start = cursor === undefined ? 0 : Number(cursor);
    const items = all.slice(start, start + PAGE);
    return Promise.resolve({
      items,
      nextCursor: start + PAGE < all.length ? String(start + PAGE) : null,
    });
  }

  #brand(brandId: string): BrandAiSettings {
    let settings = this.#brands.get(brandId);
    if (settings === undefined) {
      settings = brandFixture(brandId);
      this.#brands.set(brandId, settings);
    }
    return settings;
  }
}

const windowsOf = (
  budget: BrandAiSettings['budget'],
  usage: Pick<BrandAiSettings['usage'], 'todayUsd' | 'monthUsd'>,
): BrandAiSettings['usage']['windows'] => {
  const windows: BrandAiSettings['usage']['windows'] = [];
  const add = (period: 'day' | 'month', spentUsd: number, limitUsd: number | null): void => {
    if (limitUsd === null) {
      return;
    }
    const share = spentUsd / limitUsd;
    const level = share >= 1 ? 'exceeded' : share >= 0.8 ? 'warning' : 'ok';
    windows.push({ period, level, spentUsd, limitUsd });
  };
  add('day', usage.todayUsd, budget.dailyUsd);
  add('month', usage.monthUsd, budget.monthlyUsd);
  return windows;
};

const [FIRST_BRAND, SECOND_BRAND] = MOCK_BRANDS;

const brandFixture = (brandId: string): BrandAiSettings => {
  const first = brandId === FIRST_BRAND?.id;
  const budget = first ? { dailyUsd: 5, monthlyUsd: 50 } : { dailyUsd: null, monthlyUsd: null };
  const spend = first ? { todayUsd: 1.2, monthUsd: 50 } : { todayUsd: 0, monthUsd: 0 };
  const override = brandId === SECOND_BRAND?.id;
  return {
    providerId: override ? 'anthropic' : null,
    modelId: override ? 'claude-sonnet-4-5' : null,
    systemPrompt: first
      ? 'You are the support assistant for Helpdock, a help desk product.\nTone: warm, brief, plain words.\nOnly answer from the knowledge you are given and cite it. If you are not sure, hand off.'
      : '',
    systemPromptAr: '',
    piiRedaction: true,
    injectionFilter: true,
    budget,
    modes: first
      ? {
          ...parseAiAssistantModes({}),
          agentAssist: true,
          autoReply: {
            widget: { enabled: true, threshold: 0.7 },
            email: { enabled: false, threshold: 0.7 },
            telegram: { enabled: true, threshold: 0.8 },
          },
          handoffMessage: {
            en: 'I’m passing you to our team so a person can help. They’ll reply here, usually within an hour.',
            ar: 'سأحوّلك إلى فريقنا ليساعدك أحد الموظفين. سيصلك الرد هنا، عادةً خلال ساعة.',
          },
        }
      : parseAiAssistantModes({}),
    aiCountsAsFirstResponse: true,
    usage: { ...spend, windows: windowsOf(budget, spend) },
  };
};
