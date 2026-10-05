import {
  type CompleteRequest,
  type CompleteResult,
  createComplete,
  type ModelTransport,
  piTransport,
} from './complete.js';
import { createEmbed, type EmbedRequest, type EmbedResult } from './embed.js';
import type { HttpTransport } from './http.js';
import type { AiPorts } from './ports.js';

export * from './complete.js';
export * from './embed.js';
export * from './guardrails/budget.js';
export * from './guardrails/injection.js';
export * from './guardrails/no-tools.js';
export * from './guardrails/pii.js';
export * from './http.js';
export * from './ports.js';
export * from './providers/credentials.js';
export * from './providers/models.js';
export * from './testing.js';

export const PACKAGE_NAME = '@helpdock/ai' as const;

/** The facade every AI feature calls (M7-01). */
export interface Ai {
  complete(request: CompleteRequest): Promise<CompleteResult>;
  embed(request: EmbedRequest): Promise<EmbedResult>;
}

export interface CreateAiOptions {
  readonly ports: AiPorts;
  /** The SSRF-safe client in the api; a fake in tests. Embeddings and discovery go through it. */
  readonly http: HttpTransport;
  /** pi-ai by default; the faux provider in tests. */
  readonly transport?: ModelTransport;
  readonly clock?: () => number;
}

export const createAi = ({
  ports,
  http,
  transport = piTransport,
  clock = () => performance.now(),
}: CreateAiOptions): Ai => ({
  complete: createComplete({ ports, transport, clock }),
  embed: createEmbed({ ports, http, clock }),
});
