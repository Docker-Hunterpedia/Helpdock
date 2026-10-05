import { type AiProviderConfig, OPENAI_COMPATIBLE_KIND } from '@helpdock/config';
import {
  type Api,
  getModels,
  getProviders,
  type KnownProvider,
  type Model,
} from '@mariozechner/pi-ai';
import { getOAuthProviders } from '@mariozechner/pi-ai/oauth';
import { z } from 'zod';
import { AiHttpError, bearer, type HttpTransport, joinUrl } from '../http.js';

/**
 * Which providers exist and which models each one offers (M7-01: "model list
 * auto-discovered"). pi-ai ships a generated registry of every built-in
 * provider's models with their context windows and prices, so a built-in
 * provider's list is read from it without a request; an OpenAI-compatible
 * server (Ollama, vLLM, LM Studio, a LiteLLM proxy) is asked `GET /models`.
 */

export interface ProviderKind {
  readonly id: string;
  /** Whether pi-ai can use subscription (OAuth) credentials for it. */
  readonly oauth: boolean;
  /** Whether a base URL is required, which is only true of `openai-compatible`. */
  readonly needsBaseUrl: boolean;
}

export interface ModelInfo {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning: boolean;
  /** US dollars per million tokens; zero for a model nobody prices, such as a local one. */
  readonly inputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
}

/** A model the provider does not offer, or an unknown provider kind. */
export class ModelNotFoundError extends Error {
  constructor(providerId: string, modelId: string) {
    super(`Provider ${providerId} has no model ${modelId}`);
    this.name = 'ModelNotFoundError';
  }
}

const oauthKinds = (): ReadonlySet<string> =>
  new Set(getOAuthProviders().map((provider) => provider.id));

export const isBuiltInKind = (kind: string): kind is KnownProvider =>
  (getProviders() as readonly string[]).includes(kind);

/** Every kind a provider may be configured as, built-ins first. */
export const providerKinds = (): readonly ProviderKind[] => {
  const oauth = oauthKinds();
  return [
    ...getProviders().map((id) => ({ id, oauth: oauth.has(id), needsBaseUrl: false })),
    { id: OPENAI_COMPATIBLE_KIND, oauth: false, needsBaseUrl: true },
  ];
};

const infoOf = (model: Model<Api>): ModelInfo => ({
  id: model.id,
  name: model.name,
  contextWindow: model.contextWindow,
  maxTokens: model.maxTokens,
  reasoning: model.reasoning,
  inputPerMillionUsd: model.cost.input,
  outputPerMillionUsd: model.cost.output,
});

/** Defaults for a model an OpenAI-compatible server names but does not describe. */
const COMPATIBLE_CONTEXT_WINDOW = 128_000;
const COMPATIBLE_MAX_TOKENS = 4_096;

const compatibleModel = (
  baseUrl: string,
  provider: string,
  id: string,
): Model<'openai-completions'> => ({
  id,
  name: id,
  api: 'openai-completions',
  provider,
  baseUrl,
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: COMPATIBLE_CONTEXT_WINDOW,
  maxTokens: COMPATIBLE_MAX_TOKENS,
  // Most self-hosted servers predate the `developer` role and `store`.
  compat: { supportsDeveloperRole: false, supportsStore: false },
});

const modelListSchema = z.object({ data: z.array(z.object({ id: z.string().min(1) })) });

const discoverCompatible = async (
  provider: AiProviderConfig,
  http: HttpTransport,
): Promise<readonly ModelInfo[]> => {
  const baseUrl = provider.baseUrl ?? '';
  const url = joinUrl(baseUrl, 'models');
  const apiKey = provider.auth.type === 'apiKey' ? provider.auth.apiKey : undefined;
  const response = await http(url, { method: 'GET', headers: { ...bearer(apiKey) } });
  if (response.status < 200 || response.status >= 300) {
    throw new AiHttpError(url, response.status);
  }

  const listed = modelListSchema.parse(JSON.parse(response.body));
  return listed.data
    .map((entry) => infoOf(compatibleModel(baseUrl, provider.id, entry.id)))
    .sort((a, b) => a.id.localeCompare(b.id));
};

/** The models a configured provider offers. */
export const listModels = async (
  provider: AiProviderConfig,
  http: HttpTransport,
): Promise<readonly ModelInfo[]> => {
  if (provider.kind === OPENAI_COMPATIBLE_KIND) {
    return discoverCompatible(provider, http);
  }
  if (!isBuiltInKind(provider.kind)) {
    return [];
  }
  return getModels(provider.kind).map((model) => infoOf(model as Model<Api>));
};

/**
 * The pi-ai model to call. A built-in provider's model comes from the
 * registry, with the provider's base URL swapped in when the admin set one (a
 * regional endpoint, a gateway); an OpenAI-compatible one is described here.
 */
export const resolveModel = (provider: AiProviderConfig, modelId: string): Model<Api> => {
  if (provider.kind === OPENAI_COMPATIBLE_KIND) {
    return compatibleModel(provider.baseUrl ?? '', provider.id, modelId);
  }
  if (!isBuiltInKind(provider.kind)) {
    throw new ModelNotFoundError(provider.id, modelId);
  }

  const model = (getModels(provider.kind) as Model<Api>[]).find(
    (candidate) => candidate.id === modelId,
  );
  if (model === undefined) {
    throw new ModelNotFoundError(provider.id, modelId);
  }
  return provider.baseUrl === null ? model : { ...model, baseUrl: provider.baseUrl };
};
