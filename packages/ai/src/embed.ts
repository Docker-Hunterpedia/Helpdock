import { z } from 'zod';
import { PiiRedactor } from './guardrails/pii.js';
import { AiHttpError, bearer, type HttpTransport, joinUrl } from './http.js';
import type { AiPorts } from './ports.js';

/**
 * `embed()`: vectors from the install's one embedding model (ADR 0005,
 * ARCHITECTURE §10). The endpoint is OpenAI-compatible — OpenAI itself,
 * Voyage, a local Ollama — so this is one `POST /embeddings` rather than a
 * pi-ai call: pi-ai does chat, not embeddings.
 *
 * Every request is logged to `ai_calls` like a completion, with its tokens and
 * its cost at the configured price, but without the texts: they are knowledge
 * chunks or a visitor's question, and the chunk table or the ticket already
 * holds them. Inputs are PII-redacted under the brand's guardrail, as every
 * text sent to a model is.
 *
 * Embedding is not stopped by the budget: a brand over budget loses its
 * answers, not its index, and a re-embed is the operator's decision.
 */

export interface EmbedRequest {
  readonly brandId: string;
  /** Dotted feature name for the log, for example `knowledge.embed` or `retrieval.query`. */
  readonly feature: string;
  readonly texts: readonly string[];
}

export interface EmbedResult {
  /** One vector per text, in the order the texts were given. */
  readonly vectors: readonly (readonly number[])[];
  /** The model that produced them, to store as `knowledge_chunks.embedding_model`. */
  readonly model: string;
  readonly dims: number;
}

/** The model answered with vectors of a dimension other than the configured one. */
export class EmbeddingDimensionError extends Error {
  constructor(model: string, expected: number, received: number) {
    super(
      `Embedding model ${model} returned ${received}-dimension vectors; the install is configured for ${expected}`,
    );
    this.name = 'EmbeddingDimensionError';
  }
}

/** Inputs per request. OpenAI takes 2048; local servers are happier with fewer. */
export const EMBED_BATCH_SIZE = 64;

/** When the server reports no usage, roughly four characters a token. */
const CHARS_PER_TOKEN = 4;

const responseSchema = z.object({
  data: z.array(z.object({ index: z.int().nonnegative(), embedding: z.array(z.number()) })),
  usage: z.object({ prompt_tokens: z.int().nonnegative() }).optional(),
});

export interface EmbedDeps {
  readonly ports: AiPorts;
  readonly http: HttpTransport;
  readonly clock: () => number;
}

export const createEmbed =
  ({ ports, http, clock }: EmbedDeps) =>
  async (request: EmbedRequest): Promise<EmbedResult> => {
    const config = await ports.embedding();
    const { piiRedaction } = await ports.guardrails(request.brandId);
    const url = joinUrl(config.baseUrl, 'embeddings');
    const vectors: number[][] = [];

    for (let offset = 0; offset < request.texts.length; offset += EMBED_BATCH_SIZE) {
      const redactor = new PiiRedactor();
      const batch = request.texts
        .slice(offset, offset + EMBED_BATCH_SIZE)
        .map((text) => (piiRedaction ? redactor.redact(text) : text));
      const record = (fields: {
        status: 'ok' | 'error';
        tokensIn: number;
        latencyMs: number;
        error: string | null;
      }) =>
        ports.record({
          brandId: request.brandId,
          ticketId: null,
          feature: request.feature,
          provider: config.provider,
          model: config.model,
          tokensOut: 0,
          costUsd: (fields.tokensIn * config.pricePerMillionTokens) / 1_000_000,
          redactions: [],
          prompt: null,
          promptHash: null,
          response: null,
          sources: null,
          ...fields,
        });

      const started = clock();
      let body: z.infer<typeof responseSchema>;
      try {
        const response = await http(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...bearer(config.apiKey) },
          body: JSON.stringify({ model: config.model, input: batch }),
        });
        if (response.status < 200 || response.status >= 300) {
          throw new AiHttpError(url, response.status);
        }
        body = responseSchema.parse(JSON.parse(response.body));
      } catch (error) {
        await record({
          status: 'error',
          tokensIn: 0,
          latencyMs: clock() - started,
          error: error instanceof Error ? error.message : 'unknown error',
        });
        throw error;
      }

      const ordered = [...body.data].sort((a, b) => a.index - b.index);
      const wrong = ordered.find((entry) => entry.embedding.length !== config.dims);
      if (wrong !== undefined || ordered.length !== batch.length) {
        const error = new EmbeddingDimensionError(
          config.model,
          config.dims,
          wrong?.embedding.length ?? 0,
        );
        await record({
          status: 'error',
          tokensIn: 0,
          latencyMs: clock() - started,
          error: error.message,
        });
        throw error;
      }

      await record({
        status: 'ok',
        tokensIn:
          body.usage?.prompt_tokens ??
          Math.ceil(batch.reduce((sum, text) => sum + text.length, 0) / CHARS_PER_TOKEN),
        latencyMs: clock() - started,
        error: null,
      });
      vectors.push(...ordered.map((entry) => entry.embedding));
    }

    return { vectors, model: config.model, dims: config.dims };
  };
