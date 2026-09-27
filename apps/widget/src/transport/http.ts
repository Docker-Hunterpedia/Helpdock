import type { WidgetErrorCode } from '@helpdock/schemas';
import { API_PREFIX, AUTH_SCHEME } from './protocol.js';
import { TransportError, type TransportErrorCode } from './types.js';

/**
 * The widget's REST calls: `/api/widget/:brandId/…` with the visitor's
 * credential in `Authorization: Visitor <secret>`, JSON in and out. A refusal
 * becomes an {@link ApiRefusal}: the UI reads its `code`, one of the few it
 * words for the visitor; the transport reads `reason`, the api's own.
 */

/** The api's `widget.reason` as the code the UI words (`types.ts`). */
const UI_CODE: Readonly<Record<WidgetErrorCode, TransportErrorCode>> = {
  origin_not_allowed: 'unavailable',
  unauthenticated: 'unavailable',
  rate_limited: 'rate_limited',
  captcha_required: 'captcha_failed',
  not_found: 'not_found',
  read_only: 'policy_rejected',
  content_policy: 'policy_rejected',
  unavailable: 'unavailable',
  invalid_payload: 'policy_rejected',
  internal: 'unavailable',
};

const REASON_BY_STATUS: Readonly<Record<number, WidgetErrorCode>> = {
  400: 'invalid_payload',
  401: 'unauthenticated',
  403: 'origin_not_allowed',
  404: 'not_found',
  409: 'read_only',
  413: 'content_policy',
  415: 'content_policy',
  429: 'rate_limited',
};

export class ApiRefusal extends TransportError {
  readonly reason: WidgetErrorCode | 'network';
  readonly status: number | null;

  constructor(reason: WidgetErrorCode | 'network', message: string, status: number | null) {
    super(reason === 'network' ? 'network' : UI_CODE[reason], message);
    this.name = 'ApiRefusal';
    this.reason = reason;
    this.status = status;
  }
}

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

  get<T>(path: string): Promise<T> {
    return this.#call<T>('GET', path, undefined);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.#call<T>('POST', path, body);
  }

  /** A presigned upload: straight to the bucket, with exactly the headers it was signed with. */
  async put(url: string, headers: Record<string, string>, body: Blob): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetch(url, { method: 'PUT', headers, body });
    } catch (error) {
      throw new ApiRefusal('network', error instanceof Error ? error.message : 'offline', null);
    }
    if (!response.ok) {
      throw new ApiRefusal('network', `The upload answered ${String(response.status)}`, null);
    }
  }

  /** The raw response, for the SSE stream. */
  stream(path: string, signal: AbortSignal): Promise<Response> {
    return this.#fetch(this.url(path), {
      method: 'GET',
      headers: { ...this.headers(false), accept: 'text/event-stream' },
      signal,
    });
  }

  async #call<T>(method: string, path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(this.url(path), {
        method,
        headers: this.headers(body !== undefined),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new ApiRefusal('network', error instanceof Error ? error.message : 'offline', null);
    }

    if (response.status === 204 || response.status === 202) {
      return undefined as T;
    }
    let json: unknown;
    try {
      const text = await response.text();
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      // A body cut off by a dropped connection, or a proxy's HTML error page.
      throw new ApiRefusal('network', 'The answer could not be read', response.status);
    }
    if (response.ok) {
      return json as T;
    }
    throw refusalOf(response.status, json);
  }
}

const REASONS = new Set<string>(Object.keys(UI_CODE));

/** The api's error body (`{ error: { message, widget?: { reason } } }`) as a refusal. */
export const refusalOf = (status: number, body: unknown): ApiRefusal => {
  const error = (
    body as { error?: { message?: unknown; widget?: { reason?: unknown } } } | undefined
  )?.error;
  const named = error?.widget?.reason;
  const reason: WidgetErrorCode =
    typeof named === 'string' && REASONS.has(named)
      ? (named as WidgetErrorCode)
      : (REASON_BY_STATUS[status] ?? (status >= 500 ? 'internal' : 'invalid_payload'));
  const message = typeof error?.message === 'string' ? error.message : `HTTP ${String(status)}`;

  return new ApiRefusal(reason, message, status);
};
