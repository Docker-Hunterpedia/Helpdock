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
import { createTranscribe, type TranscribeRequest, type TranscribeResult } from './transcribe.js';

export * from './assist/index.js';
export * from './auto-reply/index.js';
export * from './complete.js';
export * from './embed.js';
export * from './guardrails/budget.js';
export * from './guardrails/injection.js';
export * from './guardrails/no-tools.js';
export * from './guardrails/pii.js';
export * from './http.js';
export * from './knowledge/index.js';
export * from './ports.js';
export * from './providers/credentials.js';
export * from './providers/models.js';
export * from './testing.js';
export * from './transcribe.js';

export const PACKAGE_NAME = '@helpdock/ai' as const;

/** The facade every AI feature calls (M7-01). */
export interface Ai {
  complete(request: CompleteRequest): Promise<CompleteResult>;
  embed(request: EmbedRequest): Promise<EmbedResult>;
  /** M7-09: a voice note's words from the install's Whisper-compatible endpoint. */
  transcribe(request: TranscribeRequest): Promise<TranscribeResult>;
}

export interface CreateAiOptions {
  readonly ports: AiPorts;
  /** The SSRF-safe client in the api; a fake in tests. Embeddings, discovery and transcription go through it. */
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
  transcribe: createTranscribe({ ports, http, clock }),
});
