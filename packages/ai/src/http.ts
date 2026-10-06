/**
 * The HTTP this package does itself — model discovery on an OpenAI-compatible
 * server and every embeddings request — goes through a transport the caller
 * passes in. The api passes the SSRF-safe client of DOMAIN-RULES §13; tests
 * pass a fake, so no test reaches the network.
 */
export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

export type HttpTransport = (url: string, request: HttpRequest) => Promise<HttpResponse>;

/** A provider answered with something other than success. */
export class AiHttpError extends Error {
  readonly status: number;

  constructor(url: string, status: number) {
    super(`${new URL(url).host} answered HTTP ${status}`);
    this.name = 'AiHttpError';
    this.status = status;
  }
}

/** `base` with a trailing slash or without, joined to `path`. */
export const joinUrl = (base: string, path: string): string =>
  `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

export const bearer = (apiKey: string | undefined): Record<string, string> =>
  apiKey === undefined || apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` };
