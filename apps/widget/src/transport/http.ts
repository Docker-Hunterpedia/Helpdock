import { WidgetTransportError, type WidgetTransportErrorCode } from './contract.js';
import { API_PREFIX, AUTH_SCHEME } from './protocol.js';

/**
 * The widget's REST calls: `/api/widget/:brandId/…` with the visitor's
 * credential in `Authorization: Visitor <secret>`, JSON in and out, and every
 * refusal turned into a {@link WidgetTransportError} carrying the api's
 * `widget.reason` — the code the UI translates.
 */

const API_CODES = new Set<WidgetTransportErrorCode>([
  'origin_not_allowed',
  'unauthenticated',
  'rate_limited',
  'captcha_required',
  'not_found',
  'read_only',
  'content_policy',
  'unavailable',
  'invalid_payload',
  'internal',
]);

const FALLBACK_BY_STATUS: Readonly<Record<number, WidgetTransportErrorCode>> = {
  400: 'invalid_payload',
  401: 'unauthenticated',
  403: 'origin_not_allowed',
  404: 'not_found',
  409: 'read_only',
  413: 'content_policy',
  415: 'content_policy',
  429: 'rate_limited',
};

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  readonly apiUrl: string;
  readonly brandId: string;
  readonly secret: () => string | null;
  readonly fetch?: FetchLike;
}

export class HttpClient {
  readonly #base: string;
  readonly #secret: () => string | null;
  readonly #fetch: FetchLike;

  constructor(options: HttpClientOptions) {
    this.#base = `${options.apiUrl.replace(/\/$/, '')}${API_PREFIX}/${options.brandId}`;
    this.#secret = options.secret;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  url(path: string): string {
    return `${this.#base}${path}`;
  }

  headers(json: boolean): Record<string, string> {
    const secret = this.#secret();
    return {
      accept: 'application/json',
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(secret === null ? {} : { authorization: `${AUTH_SCHEME} ${secret}` }),
    };
  }

  get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.#call<T>('GET', path, undefined, signal);
  }

  post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.#call<T>('POST', path, body, signal);
  }

  /** The raw response, for the SSE stream. */
  stream(path: string, signal: AbortSignal): Promise<Response> {
    return this.#fetch(this.url(path), {
      method: 'GET',
      headers: { ...this.headers(false), accept: 'text/event-stream' },
      signal,
    });
  }

  async #call<T>(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(this.url(path), {
        method,
        headers: this.headers(body !== undefined),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw new WidgetTransportError('network', error instanceof Error ? error.message : 'offline');
    }

    if (response.status === 204 || response.status === 202) {
      return undefined as T;
    }
    const text = await response.text();
    const json: unknown = text === '' ? undefined : JSON.parse(text);
    if (response.ok) {
      return json as T;
    }
    throw refusalOf(response.status, json);
  }
}

/** The api's error body (`{ error: { message, widget?: { reason } } }`) as a transport error. */
export const refusalOf = (status: number, body: unknown): WidgetTransportError => {
  const error = (
    body as { error?: { message?: unknown; widget?: { reason?: unknown } } } | undefined
  )?.error;
  const reason = error?.widget?.reason;
  const code =
    typeof reason === 'string' && API_CODES.has(reason as WidgetTransportErrorCode)
      ? (reason as WidgetTransportErrorCode)
      : (FALLBACK_BY_STATUS[status] ?? (status >= 500 ? 'internal' : 'invalid_payload'));
  const message = typeof error?.message === 'string' ? error.message : `HTTP ${String(status)}`;

  return new WidgetTransportError(code, message, status);
};

/** Worth another attempt with the same `clientId`: the network, or the server having a bad moment. */
export const isRetryable = (error: unknown): boolean =>
  error instanceof WidgetTransportError &&
  (error.code === 'network' || (error.status !== null && error.status >= 500));
