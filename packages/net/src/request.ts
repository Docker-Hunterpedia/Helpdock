/**
 * One hop: an HTTP request that connects to an already-validated address while
 * still presenting the original hostname to the server.
 *
 * Built on `node:http` / `node:https` rather than `fetch` because the `lookup`
 * option is the only way to pin the socket to the address that was checked. The
 * `Host` header and the TLS SNI name both come from `hostname`, which stays the
 * name the caller asked for.
 */

import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
  RequestOptions,
} from 'node:http';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import type { Destination } from './destination.js';
import { SafeFetchError, type SafeFetchErrorDetails } from './errors.js';
import { isIpLiteral } from './ip-address.js';
import type { ResolvedPolicy } from './policy.js';

/** Statuses that carry a `Location` worth following. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export type ResponseHeaders = Readonly<Record<string, string | string[]>>;

export interface HopResult {
  readonly status: number;
  readonly headers: ResponseHeaders;
  /** Empty when the hop is a redirect. */
  readonly body: Buffer;
  /** Present only when the hop is a redirect. */
  readonly location: string | undefined;
}

export interface HopRequest {
  readonly destination: Destination;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer | undefined;
  readonly policy: ResolvedPolicy;
  readonly hop: number;
  /** Fires on the total-time budget or on the caller's own signal. */
  readonly signal: AbortSignal;
  /** Builds the error to surface when `signal` fires. */
  readonly abortError: (details: Partial<SafeFetchErrorDetails>) => unknown;
}

interface Settlement {
  readonly resolve: (result: HopResult) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Hands the socket the address we validated. `net` asks for one address or for
 * all of them depending on the connect strategy, so both shapes are answered.
 */
function pinnedLookup(destination: Destination): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address: destination.address, family: destination.family }]);
      return;
    }
    callback(null, destination.address, destination.family);
  };
}

function toResponseHeaders(headers: IncomingHttpHeaders): ResponseHeaders {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}

function errorDetails(request: HopRequest): Partial<SafeFetchErrorDetails> {
  return {
    url: request.destination.target.url.href,
    host: request.destination.target.hostname,
    address: request.destination.address,
    hop: request.hop,
  };
}

function describeDestination(request: HopRequest): string {
  return `${request.destination.target.hostname} (${request.destination.address})`;
}

function requestOptions(request: HopRequest): RequestOptions {
  const { target } = request.destination;

  return {
    protocol: target.url.protocol,
    hostname: target.hostname,
    port: target.port,
    method: request.method,
    path: `${target.url.pathname}${target.url.search}`,
    headers: request.headers,
    lookup: pinnedLookup(request.destination),
    // A fresh, unpooled socket per request: a keep-alive pool is keyed by host
    // and port, so a reused socket would skip the pinned lookup.
    agent: false,
    signal: request.signal,
    // SNI must carry the name, and must be absent for a literal address.
    ...(isIpLiteral(target.hostname) ? {} : { servername: target.hostname }),
  };
}

function declaredLength(headers: IncomingHttpHeaders): number | undefined {
  const header = headers['content-length'];
  if (typeof header !== 'string') {
    return undefined;
  }
  const value = Number(header);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function tooLarge(request: HopRequest, size: number): SafeFetchError {
  return new SafeFetchError(
    'body-too-large',
    `response body exceeds the ${request.policy.maxBodyBytes} byte cap (${size} bytes) from ${describeDestination(request)}`,
    errorDetails(request),
  );
}

function networkError(request: HopRequest, cause: unknown): SafeFetchError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new SafeFetchError(
    'network-error',
    `request to ${describeDestination(request)} failed: ${reason}`,
    errorDetails(request),
    { cause },
  );
}

/** Translates a socket failure, taking an abort to mean the deadline or the caller. */
function failureFor(request: HopRequest, error: unknown): unknown {
  if (request.signal.aborted) {
    return request.abortError(errorDetails(request));
  }
  return error instanceof SafeFetchError ? error : networkError(request, error);
}

function readBody(
  response: IncomingMessage,
  request: HopRequest,
  onComplete: (body: Buffer) => void,
  onFailure: (error: unknown) => void,
): void {
  const declared = declaredLength(response.headers);
  if (declared !== undefined && declared > request.policy.maxBodyBytes) {
    response.destroy();
    onFailure(tooLarge(request, declared));
    return;
  }

  const chunks: Buffer[] = [];
  let received = 0;

  response.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > request.policy.maxBodyBytes) {
      // Rejected before appending: nothing past the cap is ever accumulated.
      chunks.length = 0;
      response.destroy();
      onFailure(tooLarge(request, received));
      return;
    }
    chunks.push(chunk);
  });

  response.on('end', () => {
    onComplete(Buffer.concat(chunks));
  });
}

function handleResponse(
  response: IncomingMessage,
  request: HopRequest,
  settlement: Settlement,
): void {
  const headers = toResponseHeaders(response.headers);
  const status = response.statusCode ?? 0;
  const location = response.headers.location;

  if (REDIRECT_STATUSES.has(status) && location !== undefined) {
    // A redirect body is never read: it is not part of the answer, and reading
    // it would spend the size budget on a page we discard.
    response.destroy();
    settlement.resolve({ status, headers, body: Buffer.alloc(0), location });
    return;
  }

  response.on('error', (error: unknown) => {
    settlement.reject(failureFor(request, error));
  });

  readBody(
    response,
    request,
    (body) => {
      settlement.resolve({ status, headers, body, location: undefined });
    },
    settlement.reject,
  );
}

/**
 * Aborts the request if the handshake outlasts its budget. For HTTPS the budget
 * covers the TLS handshake too, which is where a stalling peer usually hides.
 */
function armConnectTimeout(clientRequest: ClientRequest, request: HopRequest): () => void {
  let timer: NodeJS.Timeout | undefined;
  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const established =
    request.destination.target.url.protocol === 'https:' ? 'secureConnect' : 'connect';

  clientRequest.on('socket', (socket) => {
    if (!socket.connecting) {
      return;
    }
    socket.once(established, clear);
    timer = setTimeout(() => {
      clientRequest.destroy(
        new SafeFetchError(
          'timeout',
          `connect to ${describeDestination(request)} timed out after ${request.policy.connectTimeoutMs} ms`,
          errorDetails(request),
        ),
      );
    }, request.policy.connectTimeoutMs);
  });

  return clear;
}

export async function performHop(request: HopRequest): Promise<HopResult> {
  const transport = request.destination.target.url.protocol === 'https:' ? https : http;

  return await new Promise<HopResult>((resolve, reject) => {
    const clientRequest = transport.request(requestOptions(request));
    const clearConnectTimeout = armConnectTimeout(clientRequest, request);

    const settlement: Settlement = {
      resolve: (result) => {
        clearConnectTimeout();
        resolve(result);
      },
      reject: (error) => {
        clearConnectTimeout();
        reject(error);
      },
    };

    clientRequest.on('error', (error: unknown) => {
      settlement.reject(failureFor(request, error));
    });

    clientRequest.on('response', (response) => {
      clearConnectTimeout();
      handleResponse(response, request, settlement);
    });

    if (request.body !== undefined) {
      clientRequest.write(request.body);
    }
    clientRequest.end();
  });
}
