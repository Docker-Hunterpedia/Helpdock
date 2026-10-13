import { randomBytes } from 'node:crypto';
import {
  type BlockedEvent,
  type LookupFunction,
  policies,
  SafeFetchError,
  safeFetch,
} from '@helpdock/net';
import type { MetaPlatform } from '@helpdock/schemas';
import {
  classifyGraphError,
  GraphApiFailure,
  GraphTokenFormatError,
  redactToken,
} from './errors.js';

/**
 * The Graph API calls Helpdock makes (M10-01, ADR 0025), every one through the
 * SSRF-safe client of DOMAIN-RULES §13.
 *
 * Telegram's client skips that client because its host is operator
 * configuration. Here a Messenger or Instagram attachment is a URL *inside the
 * webhook payload*, and a WhatsApp media URL comes back from Graph, so these
 * fetches of a user-triggered URL must pass it, and one client for every call
 * keeps one policy. The host is also checked against an allow-list **before**
 * the call: the two Graph roots, `lookaside.fbsbx.com` and `*.fbcdn.net`, and
 * the account's token is sent only to hosts on it.
 *
 * Every path names the Graph version; nothing is called unversioned.
 */

export const DEFAULT_META_GRAPH_VERSION = 'v25.0';
export const DEFAULT_META_GRAPH_API_ROOT = 'https://graph.facebook.com';
export const DEFAULT_META_INSTAGRAM_API_ROOT = 'https://graph.instagram.com';

/** Where WhatsApp media is served from, after `GET /{media-id}` names the URL. */
export const META_MEDIA_HOST = 'lookaside.fbsbx.com';
/** Messenger and Instagram attachments are served from subdomains of this. */
export const META_CDN_DOMAIN = 'fbcdn.net';

/** The two hosts Graph is served from. WhatsApp and Messenger use the first, Instagram the second. */
export type GraphApi = 'graph' | 'instagram';

/** Which of the two roots a platform's calls go to. */
export const graphApiFor = (platform: MetaPlatform): GraphApi =>
  platform === 'instagram' ? 'instagram' : 'graph';

const VERSION = /^v\d+\.\d+$/;
const DEFAULT_PORTS: readonly number[] = [80, 443, 8080, 8443];

/** A Graph path: letters, digits and the few characters an id or an edge name uses. */
const PATH = /^\/[A-Za-z0-9_.:@-]+(?:\/[A-Za-z0-9_.:@-]+)*$/;

const hostOf = (root: string): string => new URL(root).hostname.toLowerCase();

// A loop rather than `/\/+$/`: the root comes from configuration, and a
// trailing-repetition regex on it is the pattern CodeQL flags as polynomial.
const withoutTrailingSlashes = (url: string): string => {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') {
    end -= 1;
  }
  return url.slice(0, end);
};

/**
 * Whether `hostname` is one Helpdock may fetch from or send a token to: the two
 * Graph roots (the defaults, or the ones `META_GRAPH_API_ROOT` and
 * `META_INSTAGRAM_API_ROOT` name), Meta's WhatsApp media host, or any
 * subdomain of its CDN domain. Case and a trailing dot do not matter.
 */
export const isAllowedGraphHost = (
  hostname: string,
  roots: readonly string[] = [DEFAULT_META_GRAPH_API_ROOT, DEFAULT_META_INSTAGRAM_API_ROOT],
): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') {
    return false;
  }

  return (
    roots.some((root) => hostOf(root) === host) ||
    host === META_MEDIA_HOST ||
    (host.endsWith(`.${META_CDN_DOMAIN}`) && host.length > META_CDN_DOMAIN.length + 1)
  );
};

export interface GraphClientOptions {
  /** `META_GRAPH_API_ROOT`. */
  readonly root?: string;
  /** `META_INSTAGRAM_API_ROOT`. */
  readonly instagramRoot?: string;
  /** `META_GRAPH_VERSION`. */
  readonly version?: string;
  /** `OUTBOUND_ALLOW_CIDRS`: how a test reaches a stand-in on 127.0.0.1. */
  readonly allowCidrs: readonly string[];
  /** Resolver override, for tests. */
  readonly lookup?: LookupFunction;
  /**
   * Called for every refused destination so the caller can log it (DOMAIN-RULES
   * §13): by the SSRF-safe client for an address it will not connect to, and by
   * this client for a host that is not Meta's, which it refuses before any
   * address is looked up. Never the query string.
   */
  readonly onBlocked?: (event: BlockedEvent) => void;
}

export interface GraphRequest {
  readonly token: string;
  /** Default `graph`. */
  readonly api?: GraphApi;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
}

export interface GraphJsonRequest extends GraphRequest {
  readonly json?: unknown;
}

export interface GraphUpload {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface GraphMultipartRequest extends GraphRequest {
  /** Text fields beside the file, such as `messaging_product` and `type`. */
  readonly fields: Readonly<Record<string, string>>;
  readonly file: GraphUpload;
}

export interface GraphDownloadRequest {
  /** Sent only to a host that is a Graph root or the WhatsApp media host. */
  readonly token?: string;
  /** The response is refused past this many bytes. */
  readonly maxBytes: number;
  readonly timeoutMs?: number;
}

export interface GraphDownload {
  readonly bytes: Buffer;
  readonly contentType: string | null;
}

/** A header value that cannot carry a second header. */
const HEADER_TOKEN = /^[\x21-\x7e]+$/;

const assertToken = (token: string): void => {
  if (!HEADER_TOKEN.test(token)) {
    throw new GraphTokenFormatError();
  }
};

/** A multipart field or file name that cannot close its own quotes or end its own line. */
const quoted = (value: string): string => value.replace(/["\\\r\n]/g, '_');

const encoder = new TextEncoder();

/**
 * A `multipart/form-data` body built by hand as bytes: `safeFetch` takes a
 * string or bytes, never a stream or a `FormData`, and a 100 MB document is
 * already in memory by then.
 */
export const multipartBody = (
  boundary: string,
  fields: Readonly<Record<string, string>>,
  file: GraphUpload,
): Uint8Array => {
  const chunks: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(name)}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quoted(file.name)}"\r\nContent-Type: ${file.contentType.replace(/[\r\n]/g, '')}\r\n\r\n`,
    ),
    file.bytes,
    encoder.encode(`\r\n--${boundary}--\r\n`),
  );

  return Buffer.concat(chunks);
};

export class GraphClient {
  readonly #roots: Readonly<Record<GraphApi, string>>;
  readonly #version: string;
  readonly #allowCidrs: readonly string[];
  readonly #allowedPorts: readonly number[];
  readonly #lookup: LookupFunction | undefined;
  readonly #onBlocked: ((event: BlockedEvent) => void) | undefined;

  constructor(options: GraphClientOptions) {
    const version = options.version ?? DEFAULT_META_GRAPH_VERSION;
    if (!VERSION.test(version)) {
      throw new TypeError(`A Graph version looks like v25.0, got ${version}`);
    }
    const graph = withoutTrailingSlashes(options.root ?? DEFAULT_META_GRAPH_API_ROOT);
    const instagram = withoutTrailingSlashes(
      options.instagramRoot ?? DEFAULT_META_INSTAGRAM_API_ROOT,
    );
    const ports = [graph, instagram].map((root) => {
      const url = URL.parse(root);
      if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
        throw new TypeError(`A Graph root is an http(s) URL, got ${root}`);
      }
      return url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
    });

    this.#roots = { graph, instagram };
    this.#version = version;
    this.#allowCidrs = options.allowCidrs;
    // A stand-in listens on a port of its own, and the operator who pointed a
    // root at it chose that port; every other call keeps the usual four.
    this.#allowedPorts = [...new Set([...DEFAULT_PORTS, ...ports])];
    this.#lookup = options.lookup;
    this.#onBlocked = options.onBlocked;
  }

  /** `GET`, answered as the parsed JSON. */
  get(path: string, request: GraphRequest): Promise<unknown> {
    return this.#json('GET', path, request, undefined);
  }

  /** `POST` with a JSON body, or none (`subscribed_apps`), answered as the parsed JSON. */
  post(path: string, request: GraphJsonRequest): Promise<unknown> {
    return this.#json('POST', path, request, request.json);
  }

  /** `DELETE`, answered as the parsed JSON. */
  delete(path: string, request: GraphRequest): Promise<unknown> {
    return this.#json('DELETE', path, request, undefined);
  }

  /** `POST` of one file and its text fields, as `POST /{phone-number-id}/media` wants. */
  async postMultipart(path: string, request: GraphMultipartRequest): Promise<unknown> {
    const boundary = `----helpdock${randomBytes(12).toString('hex')}`;
    const url = this.#url(path, request);

    return this.#parse(
      await this.#send(url, request.token, {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: multipartBody(boundary, request.fields, request.file),
      }),
      request.token,
    );
  }

  /**
   * The bytes at a URL Graph or a webhook named. The host has to be on the
   * allow-list before anything is sent, a redirect is never followed, and a
   * response past `maxBytes` is refused as it arrives.
   */
  async download(url: string, request: GraphDownloadRequest): Promise<GraphDownload> {
    const target = URL.parse(url);
    if (target === null) {
      throw new GraphApiFailure('permanent', 'The file address is not a URL', {
        reason: 'host-not-allowed',
      });
    }
    this.#assertHost(target);
    // The token goes to Graph and to the WhatsApp media host, never to a CDN
    // that serves other people's files from the same hostnames.
    const sendToken =
      request.token !== undefined &&
      (target.hostname.toLowerCase() === META_MEDIA_HOST || this.#isRoot(target.hostname));
    if (sendToken && request.token !== undefined) {
      assertToken(request.token);
    }

    const response = await this.#send(
      target,
      sendToken ? request.token : undefined,
      { method: 'GET' },
      {
        maxBodyBytes: request.maxBytes,
        ...(request.timeoutMs === undefined ? {} : { totalTimeoutMs: request.timeoutMs }),
      },
    );
    if (response.status < 200 || response.status > 299) {
      throw classifyGraphError(response.status, parseJson(response.body), request.token);
    }
    const contentType = response.headers['content-type'];

    return {
      bytes: response.body,
      contentType: Array.isArray(contentType) ? (contentType[0] ?? null) : (contentType ?? null),
    };
  }

  #isRoot(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return hostOf(this.#roots.graph) === host || hostOf(this.#roots.instagram) === host;
  }

  #assertHost(url: URL): void {
    if (!isAllowedGraphHost(url.hostname, [this.#roots.graph, this.#roots.instagram])) {
      this.#report({
        code: 'destination-blocked',
        // The scheme, host and path: the query of a media link carries Meta's signature.
        url: `${url.protocol}//${url.host}${url.pathname}`,
        host: url.hostname,
        address: undefined,
        hop: 0,
        reason: 'host-not-allowed',
      });
      throw new GraphApiFailure(
        'permanent',
        `${url.hostname} is not a Meta host, so it is not fetched`,
        {
          reason: 'host-not-allowed',
        },
      );
    }
  }

  /** A logging sink must not mask the refusal that triggered it. */
  #report(event: BlockedEvent): void {
    try {
      this.#onBlocked?.(event);
    } catch {
      // Intentionally ignored: see above.
    }
  }

  #url(path: string, request: GraphRequest): URL {
    if (
      !PATH.test(path) ||
      path.split('/').some((segment) => segment === '.' || segment === '..')
    ) {
      throw new TypeError(`Not a Graph path: ${path}`);
    }
    assertToken(request.token);
    const url = new URL(`${this.#roots[request.api ?? 'graph']}/${this.#version}${path}`);
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }
    this.#assertHost(url);

    return url;
  }

  async #json(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    request: GraphRequest,
    json: unknown,
  ): Promise<unknown> {
    const url = this.#url(path, request);
    const response = await this.#send(url, request.token, {
      method,
      ...(json === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }),
    });

    return this.#parse(response, request.token);
  }

  /** A success as its parsed body; anything else as the failure it classifies to. */
  #parse(response: { readonly status: number; readonly body: Buffer }, token: string): unknown {
    const body = parseJson(response.body);
    if (response.status < 200 || response.status > 299) {
      throw classifyGraphError(response.status, body, token);
    }
    if (body === undefined) {
      // A 2xx that is not JSON is Graph failing, not a request to repeat unchanged.
      throw new GraphApiFailure('retry', 'Graph answered with something other than JSON', {
        status: response.status,
      });
    }

    return body;
  }

  async #send(
    url: URL,
    token: string | undefined,
    init: {
      readonly method: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string | Uint8Array;
    },
    policy: { readonly maxBodyBytes?: number; readonly totalTimeoutMs?: number } = {},
  ) {
    try {
      return await safeFetch(
        url.href,
        {
          method: init.method,
          headers: {
            accept: 'application/json, */*',
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
            ...init.headers,
          },
          ...(init.body === undefined ? {} : { body: init.body }),
        },
        {
          ...policies.graph,
          ...policy,
          allowCidrs: [...this.#allowCidrs],
          allowedPorts: [...this.#allowedPorts],
          // A redirect would carry the call to a host nobody checked.
          maxRedirects: 0,
          ...(this.#lookup === undefined ? {} : { lookup: this.#lookup }),
          ...(this.#onBlocked === undefined ? {} : { onBlocked: this.#onBlocked }),
        },
      );
    } catch (error) {
      throw toTransportFailure(error, token);
    }
  }
}

/** The parsed JSON of a body, `undefined` when it is empty or not JSON. */
const parseJson = (body: Buffer): unknown => {
  if (body.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * What `safeFetch` threw as the failure a caller handles. A network that failed
 * is Graph being unreachable, which is worth another attempt; a destination the
 * client refused, a redirect, a body past its cap are not.
 */
const toTransportFailure = (error: unknown, token: string | undefined): unknown => {
  if (!(error instanceof SafeFetchError)) {
    return error;
  }
  const detail = redactToken(error.message, token);
  switch (error.code) {
    case 'timeout':
    case 'network-error':
    case 'dns-failure':
      return new GraphApiFailure('retry', detail, { reason: 'transport' });
    case 'body-too-large':
      return new GraphApiFailure('permanent', detail, { reason: 'too-large' });
    default:
      return new GraphApiFailure('permanent', detail, { reason: 'blocked' });
  }
};
