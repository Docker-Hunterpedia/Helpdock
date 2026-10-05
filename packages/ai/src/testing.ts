import type { AiProviderConfig, OAuthCredentialsValue } from '@helpdock/config';
import {
  type AssistantMessage,
  type Context,
  complete,
  type FauxResponseStep,
  fauxAssistantMessage,
  registerFauxProvider,
} from '@mariozechner/pi-ai';
import type { ModelTransport } from './complete.js';

export * from './knowledge/connectors/fake-service.js';
export * from './knowledge/fixtures.js';

import { BudgetExceededError } from './guardrails/budget.js';
import type { HttpRequest, HttpResponse, HttpTransport } from './http.js';
import {
  type AiCallRecord,
  AiNotConfiguredError,
  type AiPorts,
  type AiTarget,
  type BrandGuardrails,
  type EmbeddingConfig,
  EmbeddingNotConfiguredError,
} from './ports.js';

/**
 * Test doubles for every AI feature, so no suite reaches a provider (CI has no
 * network and no keys). Exported from the package because the features that
 * build on the facade — retrieval, assist, auto-reply — test against the same
 * doubles.
 *
 * - {@link createFakeModel}: pi-ai's own faux provider behind the facade's
 *   transport. The facade still resolves the configured model and credential;
 *   only the HTTP is replaced, by scripted answers.
 * - {@link fakeEmbeddingsServer}: an OpenAI-compatible `/embeddings` and
 *   `/models` answering deterministic vectors.
 * - {@link InMemoryAiPorts}: the ports, with the calls it was asked to record.
 */

export interface SentRequest {
  readonly model: { readonly provider: string; readonly id: string };
  readonly context: Context;
  readonly apiKey: string | undefined;
}

export interface FakeModel {
  readonly transport: ModelTransport;
  /** Every request the facade sent, in order. */
  readonly sent: readonly SentRequest[];
  /** Queues answers; a string is a plain text answer. */
  reply(...answers: readonly (string | FauxResponseStep)[]): void;
  unregister(): void;
}

export const createFakeModel = (): FakeModel => {
  const registration = registerFauxProvider({ models: [{ id: 'fake-model' }] });
  const sent: SentRequest[] = [];

  return {
    sent,
    transport: (model, context, options): Promise<AssistantMessage> => {
      sent.push({
        model: { provider: model.provider, id: model.id },
        context,
        apiKey: options.apiKey,
      });
      return complete(registration.getModel(), context, options);
    },
    reply: (...answers) => {
      registration.appendResponses(
        answers.map((answer) =>
          typeof answer === 'string' ? fauxAssistantMessage(answer) : answer,
        ),
      );
    },
    unregister: () => registration.unregister(),
  };
};

/** A faux answer the provider failed with, for a feature's failure path. */
export const fakeModelError = (message: string): FauxResponseStep =>
  fauxAssistantMessage('', { stopReason: 'error', errorMessage: message });

export interface FakeEmbeddingsServer {
  readonly http: HttpTransport;
  readonly requests: readonly { readonly url: string; readonly request: HttpRequest }[];
  /** Answers every request with this status instead, until cleared with null. */
  failWith(status: number | null): void;
}

/**
 * A vector that depends only on the text, so the same text always embeds the
 * same way and two texts almost never collide.
 */
export const fakeVector = (text: string, dims: number): number[] => {
  let seed = 0;
  for (const character of text) {
    seed = (seed * 31 + character.charCodeAt(0)) % 1_000_003;
  }
  return Array.from({ length: dims }, (_, index) => ((seed + index * 7_919) % 1_000) / 1_000);
};

export const fakeEmbeddingsServer = (
  dims: number,
  models: readonly string[] = ['fake-embedding'],
): FakeEmbeddingsServer => {
  const requests: { url: string; request: HttpRequest }[] = [];
  let failure: number | null = null;

  const answer = (status: number, body: unknown): HttpResponse => ({
    status,
    body: JSON.stringify(body),
  });

  return {
    requests,
    failWith: (status) => {
      failure = status;
    },
    http: (url, request) => {
      requests.push({ url, request });
      if (failure !== null) {
        return Promise.resolve(answer(failure, { error: 'scripted failure' }));
      }
      if (url.endsWith('/models')) {
        return Promise.resolve(answer(200, { data: models.map((id) => ({ id })) }));
      }
      const { input } = JSON.parse(typeof request.body === 'string' ? request.body : '{}') as {
        input: string[];
      };
      return Promise.resolve(
        answer(200, {
          data: input.map((text, index) => ({ index, embedding: fakeVector(text, dims) })),
          usage: { prompt_tokens: input.join(' ').length },
        }),
      );
    },
  };
};

export interface InMemoryAiPortsOptions {
  readonly provider?: AiProviderConfig;
  readonly modelId?: string;
  readonly systemPrompt?: string;
  readonly guardrails?: BrandGuardrails;
  readonly embedding?: EmbeddingConfig | null;
}

export const FAKE_PROVIDER: AiProviderConfig = {
  id: 'fake',
  kind: 'openai',
  label: 'Fake',
  baseUrl: null,
  auth: { type: 'apiKey', apiKey: 'sk-fake' },
};

export class InMemoryAiPorts implements AiPorts {
  readonly calls: AiCallRecord[] = [];
  readonly savedCredentials: { providerId: string; credentials: OAuthCredentialsValue }[] = [];
  provider: AiProviderConfig | null;
  modelId: string;
  systemPrompt: string;
  piiRedaction: boolean;
  embeddingConfig: EmbeddingConfig | null;
  /** Set to make the next calls refuse. */
  budgetExceeded: BudgetExceededError | null = null;

  constructor(options: InMemoryAiPortsOptions = {}) {
    this.provider = options.provider ?? FAKE_PROVIDER;
    this.modelId = options.modelId ?? 'gpt-4o-mini';
    this.systemPrompt = options.systemPrompt ?? '';
    this.piiRedaction = options.guardrails?.piiRedaction ?? true;
    this.embeddingConfig = options.embedding === undefined ? null : options.embedding;
  }

  target(brandId: string): Promise<AiTarget> {
    if (this.provider === null) {
      return Promise.reject(new AiNotConfiguredError(brandId));
    }
    return Promise.resolve({
      provider: this.provider,
      modelId: this.modelId,
      systemPrompt: this.systemPrompt,
    });
  }

  guardrails(): Promise<BrandGuardrails> {
    return Promise.resolve({ piiRedaction: this.piiRedaction });
  }

  assertWithinBudget(): Promise<void> {
    return this.budgetExceeded === null ? Promise.resolve() : Promise.reject(this.budgetExceeded);
  }

  record(call: AiCallRecord): Promise<string> {
    this.calls.push(call);
    return Promise.resolve(`call-${this.calls.length}`);
  }

  saveCredentials(providerId: string, credentials: OAuthCredentialsValue): Promise<void> {
    this.savedCredentials.push({ providerId, credentials });
    return Promise.resolve();
  }

  embedding(): Promise<EmbeddingConfig> {
    return this.embeddingConfig === null
      ? Promise.reject(new EmbeddingNotConfiguredError())
      : Promise.resolve(this.embeddingConfig);
  }

  /** A budget refusal for the next calls, as the api's budget meter would raise it. */
  exceedBudget(brandId: string): void {
    this.budgetExceeded = new BudgetExceededError(brandId, {
      period: 'day',
      spentUsd: 10,
      limitUsd: 10,
    });
  }
}
