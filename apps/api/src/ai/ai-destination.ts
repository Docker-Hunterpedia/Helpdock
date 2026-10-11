import type { ResolveHostPolicy } from '@helpdock/net';
import { inspectDestination } from '../http/outbound-destination.js';
import { AiFailure } from './ai-failure.js';

/**
 * The check a provider base URL, the embeddings URL or the transcription
 * endpoint passes when an admin saves it (ASVS 12.6.1, 9.2.2): https, and not a
 * private, loopback or metadata address, unless the operator allowed the range
 * in `OUTBOUND_ALLOW_CIDRS`, which is how a local Ollama or whisper.cpp is
 * reached. Embeddings and transcription are checked again by `safeFetch` on
 * every request; chat completions go through pi-ai's own clients (ADR 0018),
 * so for them this save-time check is the only one.
 */
export type AiDestinationCheck = (url: string) => Promise<void>;

export const createAiDestinationCheck =
  (policy: ResolveHostPolicy): AiDestinationCheck =>
  async (url) => {
    const problem = await inspectDestination(url, policy);
    if (problem !== undefined) {
      throw new AiFailure(problem.kind);
    }
  };
