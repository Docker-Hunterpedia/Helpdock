import type { HttpTransport } from '@helpdock/ai';
import { type BlockedEvent, safeFetch } from '@helpdock/net';

/**
 * The HTTP `@helpdock/ai` does itself — the embeddings endpoint and `GET
 * /models` on an OpenAI-compatible server — through the SSRF-safe client of
 * DOMAIN-RULES §13. The base URL is an admin's to set, but it is still a URL
 * somebody typed: a private address is refused unless the operator allowed it
 * in `OUTBOUND_ALLOW_CIDRS`, which is how a local Ollama is reached.
 *
 * The port is the one exception to the client's defaults: an embeddings
 * server commonly listens on its own (Ollama on 11434), and the admin chose
 * it, so the port of the URL being asked is allowed alongside the usual four.
 */

/** A batch of 64 vectors of 2,000 floats, written as JSON, is a few megabytes. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Embedding a batch on a CPU-only server can take a while. */
const TOTAL_TIMEOUT_MS = 120_000;
const DEFAULT_PORTS = [80, 443, 8080, 8443];

const portOf = (url: URL): number => {
  if (url.port !== '') {
    return Number(url.port);
  }
  return url.protocol === 'https:' ? 443 : 80;
};

export const safeAiTransport = (
  allowCidrs: readonly string[],
  onBlocked?: (event: BlockedEvent) => void,
): HttpTransport => {
  return async (url, request) => {
    const response = await safeFetch(
      url,
      {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
      },
      {
        allowCidrs: [...allowCidrs],
        allowedPorts: [...new Set([...DEFAULT_PORTS, portOf(new URL(url))])],
        maxRedirects: 0,
        maxBodyBytes: MAX_BODY_BYTES,
        totalTimeoutMs: TOTAL_TIMEOUT_MS,
        ...(onBlocked === undefined ? {} : { onBlocked }),
      },
    );
    return { status: response.status, body: response.body.toString('utf8') };
  };
};
