import type { AiProviderConfig, OAuthCredentialsValue } from '@helpdock/config';
import type { Redaction } from './guardrails/pii.js';

/**
 * What `createAi` needs from the application, so this package holds the
 * rules — redaction, the budget gate, no tools, the call log — and knows
 * nothing about Postgres, settings or Nest. The api implements every port
 * against the `settings` table, `ai_settings` and `ai_calls`; a test
 * implements them in memory.
 */

/** Which model a brand's call goes to, and what it is told before the conversation. */
export interface AiTarget {
  readonly provider: AiProviderConfig;
  readonly modelId: string;
  /** The brand's own system prompt (M7-08), empty when it has none. */
  readonly systemPrompt: string;
}

export interface BrandGuardrails {
  readonly piiRedaction: boolean;
}

/** The install's one embedding model (ADR 0005). */
export interface EmbeddingConfig {
  /** A label for the log, such as `openai` or `ollama`. */
  readonly provider: string;
  /** OpenAI-compatible endpoint root, for example `https://api.openai.com/v1`. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly dims: number;
  readonly pricePerMillionTokens: number;
}

export type AiCallStatus = 'ok' | 'error' | 'refused';

export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/** One row of `ai_calls`, as the facade hands it to the recorder. */
export interface AiCallRecord {
  readonly brandId: string;
  readonly ticketId: string | null;
  readonly feature: string;
  /** The configured provider's id, or the embedding provider's label. */
  readonly provider: string;
  readonly model: string;
  readonly status: AiCallStatus;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly redactions: readonly Redaction[];
  /** The redacted system prompt and messages; null for an embedding request. */
  readonly prompt: { readonly system: string; readonly messages: readonly ChatMessage[] } | null;
  readonly promptHash: string | null;
  /** The answer as the model wrote it, placeholders included. */
  readonly response: string | null;
  readonly sources: readonly unknown[] | null;
  readonly error: string | null;
}

export interface AiPorts {
  /** Throws {@link AiNotConfiguredError} when neither the brand nor the install names a model. */
  target(brandId: string): Promise<AiTarget>;
  guardrails(brandId: string): Promise<BrandGuardrails>;
  /** Throws `BudgetExceededError` once a window is spent. */
  assertWithinBudget(brandId: string): Promise<void>;
  /** Writes the `ai_calls` row and returns its id. */
  record(call: AiCallRecord): Promise<string>;
  /** Stores OAuth credentials pi-ai refreshed, so the next call starts from them. */
  saveCredentials(providerId: string, credentials: OAuthCredentialsValue): Promise<void>;
  /** Throws {@link EmbeddingNotConfiguredError} until the install has an embedding model. */
  embedding(): Promise<EmbeddingConfig>;
}

export class AiNotConfiguredError extends Error {
  constructor(brandId: string) {
    super(`No AI model is configured for brand ${brandId} or for the install`);
    this.name = 'AiNotConfiguredError';
  }
}

export class EmbeddingNotConfiguredError extends Error {
  constructor() {
    super('The install has no embedding model yet');
    this.name = 'EmbeddingNotConfiguredError';
  }
}
