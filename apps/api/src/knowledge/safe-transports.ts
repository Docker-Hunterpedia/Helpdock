import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import type { CrawlFetch } from '@helpdock/ai';
import {
  type BlockedEvent,
  policies,
  type SafeFetchPolicy,
  type SafeFetchResponse,
  safeFetch,
} from '@helpdock/net';
import type { RenderFetch } from './crawl-renderer.js';

/**
 * Every request the knowledge ingest makes, through the SSRF-safe client of
 * DOMAIN-RULES §13 — the crawler's pages, `robots.txt` and sitemaps, and the
 * Notion and Google Drive APIs. Nothing in `knowledge/` calls `fetch` itself.
 *
 * - {@link safeCrawlFetch}: the crawler's shape, a page as text, capped at the
 *   crawl's 10 MB.
 * - {@link safeFetchFunction}: a WHATWG `fetch` over the same client, for the
 *   Notion SDK and `googleapis`, which take one. It asks for no compression
 *   (the client hands back bytes as sent) and decodes a server that compresses
 *   anyway, within a bound.
 */

export const CRAWLER_USER_AGENT_HEADER =
  'HelpdockBot/1.0 (+https://github.com/Docker-Hunterpedia/Helpdock)';

/** A connector's file can be the 25 MB upload cap; its JSON pages are far smaller. */
const CONNECTOR_MAX_BYTES = 26 * 1024 * 1024;
const DECODED_MAX_BYTES = 64 * 1024 * 1024;

export interface SafeTransportOptions {
  readonly allowCidrs: readonly string[];
  readonly onBlocked?: (event: BlockedEvent) => void;
}

const policyOf = (
  { allowCidrs, onBlocked }: SafeTransportOptions,
  base: SafeFetchPolicy,
): SafeFetchPolicy => ({
  ...base,
  allowCidrs: [...allowCidrs],
  ...(onBlocked === undefined ? {} : { onBlocked }),
});

const headerValue = (response: SafeFetchResponse, name: string): string => {
  const value = response.headers[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
};

const decoderFor = (contentType: string): InstanceType<typeof TextDecoder> => {
  const charset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().replace(/"/g, '');
  try {
    return new TextDecoder(charset ?? 'utf-8');
  } catch {
    return new TextDecoder('utf-8');
  }
};

/** A body the server compressed although nobody asked: decoded, never past the bound. */
export const decodeBody = (body: Buffer, encoding: string): Buffer => {
  const options = { maxOutputLength: DECODED_MAX_BYTES };
  switch (encoding.trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return gunzipSync(body, options);
    case 'deflate':
      return inflateSync(body, options);
    case 'br':
      return brotliDecompressSync(body, options);
    default:
      return body;
  }
};

export const safeCrawlFetch = (options: SafeTransportOptions): CrawlFetch => {
  const policy = policyOf(options, policies.crawl);
  return async (url) => {
    const response = await safeFetch(
      url,
      {
        headers: {
          'user-agent': CRAWLER_USER_AGENT_HEADER,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8',
        },
      },
      policy,
    );
    const contentType = headerValue(response, 'content-type');
    const body = decodeBody(response.body, headerValue(response, 'content-encoding'));
    return {
      status: response.status,
      contentType,
      body: decoderFor(contentType).decode(body),
      url: response.url,
    };
  };
};

/** The headless browser's requests, answered through the client (`crawl-renderer.ts`). */
export const safeRenderFetch = (options: SafeTransportOptions): RenderFetch => {
  const policy = policyOf(options, policies.crawl);
  return async (url, init) => {
    const headers = Object.fromEntries(
      Object.entries(init.headers).filter(([name]) => name.toLowerCase() !== 'accept-encoding'),
    );
    const response = await safeFetch(
      url,
      {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
      },
      policy,
    );
    const flat: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers)) {
      if (name !== 'content-encoding' && name !== 'content-length') {
        flat[name] = Array.isArray(value) ? value.join(', ') : value;
      }
    }
    return {
      status: response.status,
      headers: flat,
      body: decodeBody(response.body, headerValue(response, 'content-encoding')),
    };
  };
};

const headersOf = (init: RequestInit | undefined): Record<string, string> => {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, name) => {
    if (name !== 'accept-encoding') {
      headers[name] = value;
    }
  });
  return headers;
};

const bodyOf = (body: RequestInit['body']): string | Uint8Array | undefined => {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === 'string' || body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  throw new TypeError('The knowledge connectors send only text or byte bodies');
};

const responseHeaders = (response: SafeFetchResponse): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (name === 'content-encoding' || name === 'content-length') {
      continue;
    }
    for (const one of Array.isArray(value) ? value : [value]) {
      headers.append(name, one);
    }
  }
  return headers;
};

const NO_BODY = new Set([101, 204, 205, 304]);

export const safeFetchFunction = (options: SafeTransportOptions): typeof fetch => {
  const policy = policyOf(options, { maxBodyBytes: CONNECTOR_MAX_BYTES, totalTimeoutMs: 120_000 });
  const adapted = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const body = bodyOf(init?.body);
    const response = await safeFetch(
      url,
      {
        method: init?.method ?? 'GET',
        headers: headersOf(init),
        ...(body === undefined ? {} : { body }),
        ...(init?.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
      },
      policy,
    );
    const decoded = decodeBody(response.body, headerValue(response, 'content-encoding'));
    return new Response(NO_BODY.has(response.status) ? null : new Uint8Array(decoded), {
      status: response.status,
      headers: responseHeaders(response),
    });
  };
  return adapted as typeof fetch;
};
