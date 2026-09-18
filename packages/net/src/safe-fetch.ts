/**
 * `safeFetch`: the only way Helpdock fetches a URL that a user supplied
 * (AGENTS.md, DOMAIN-RULES §13). It validates and resolves every hop, pins the
 * socket to the address it checked, and enforces the time and size budgets.
 */
import {
  type Destination,
  resolveDestination,
  type ValidatedUrl,
  validateUrl,
} from './destination.js';
import {
  asRedirectBlocked,
  SafeFetchError,
  type SafeFetchErrorCode,
  type SafeFetchErrorDetails,
} from './errors.js';
import {
  type BlockedEvent,
  type ResolvedPolicy,
  reportBlocked,
  resolvePolicy,
  type SafeFetchPolicy,
} from './policy.js';
import { performHop, type ResponseHeaders } from './request.js';

export interface SafeFetchInit {
  /** Default `GET`. */
  readonly method?: string;
  /** Header names are lower-cased. `host` is ignored; it comes from the URL. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Buffered, not streamed, so it can be replayed on a 307 or 308. */
  readonly body?: string | Uint8Array;
  /** Cancels the call. Its `reason` is what `safeFetch` then throws. */
  readonly signal?: AbortSignal;
}

export interface SafeFetchResponse {
  readonly status: number;
  readonly headers: ResponseHeaders;
  /** The raw bytes; `safeFetch` never decodes or decompresses them. */
  readonly body: Buffer;
  /** The URL that produced this response, after any redirect. */
  readonly url: string;
  /** Every URL redirected to, in order. Empty when there was no redirect. */
  readonly redirects: readonly string[];
}

/** Codes that mean "the request was refused", as opposed to "the network failed". */
const BLOCKED_CODES: ReadonlySet<SafeFetchErrorCode> = new Set([
  'invalid-url',
  'scheme-not-allowed',
  'credentials-in-url',
  'port-not-allowed',
  'dns-failure',
  'destination-blocked',
  'too-many-redirects',
  'redirect-blocked',
]);

/** Redirects that turn a non-GET into a GET, dropping the body. */
const METHOD_CHANGING_REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303]);

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const STRIPPED_ON_CROSS_ORIGIN = ['authorization', 'cookie'] as const;
const BODY_HEADERS = ['content-length', 'content-type'] as const;

function normalizeMethod(method: string): string {
  const normalized = method.toUpperCase();
  if (!HTTP_TOKEN.test(normalized)) {
    throw new TypeError(`invalid HTTP method: ${method}`);
  }
  return normalized;
}

function normalizeHeaders(headers: Readonly<Record<string, string>> = {}): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    // The Host header is derived from the URL; letting a caller set it would
    // point a pinned connection at a different virtual host.
    if (lower !== 'host') {
      normalized[lower] = value;
    }
  }
  return normalized;
}

function toBuffer(body: string | Uint8Array | undefined): Buffer | undefined {
  if (body === undefined) {
    return undefined;
  }
  return typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
}

function withBodyHeaders(
  headers: Record<string, string>,
  body: Buffer | undefined,
): Record<string, string> {
  const result = { ...headers };
  if (body === undefined) {
    for (const name of BODY_HEADERS) {
      delete result[name];
    }
    return result;
  }
  result['content-length'] = String(body.length);
  return result;
}

interface HopPlan {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer | undefined;
}

/**
 * Applies the redirect rules: 301, 302 and 303 turn a non-GET into a GET and drop
 * the body; 307 and 308 keep both. Credentials never cross an origin boundary.
 */
export function planRedirect(params: {
  readonly status: number;
  readonly previous: HopPlan;
  readonly sameOrigin: boolean;
}): HopPlan {
  const { status, previous, sameOrigin } = params;
  const downgradesToGet =
    METHOD_CHANGING_REDIRECTS.has(status) &&
    previous.method !== 'GET' &&
    previous.method !== 'HEAD';

  const method = downgradesToGet ? 'GET' : previous.method;
  const body = downgradesToGet ? undefined : previous.body;
  const headers = withBodyHeaders(previous.headers, body);

  if (!sameOrigin) {
    for (const name of STRIPPED_ON_CROSS_ORIGIN) {
      delete headers[name];
    }
  }

  return { method, headers, body };
}

async function prepareHop(
  raw: string | URL,
  policy: ResolvedPolicy,
  hop: number,
): Promise<Destination> {
  try {
    const target: ValidatedUrl = validateUrl(raw, policy, hop);
    return await resolveDestination(target, policy, hop);
  } catch (error) {
    if (hop > 0 && error instanceof SafeFetchError) {
      throw asRedirectBlocked(error);
    }
    throw error;
  }
}

function blockedEvent(error: SafeFetchError): BlockedEvent {
  return {
    code: error.code,
    url: error.url,
    host: error.host,
    address: error.address,
    hop: error.hop,
    reason: error.message,
  };
}

/** The total-time budget and the caller's signal, as one abort source. */
interface Deadline {
  readonly signal: AbortSignal;
  /** The error to surface when the signal fired: our budget, or the caller's. */
  readonly errorFor: (details: Partial<SafeFetchErrorDetails>) => unknown;
  readonly release: () => void;
}

function startDeadline(totalTimeoutMs: number, callerSignal: AbortSignal | undefined): Deadline {
  const controller = new AbortController();
  let expired = false;

  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, totalTimeoutMs);

  const onCallerAbort = (): void => {
    controller.abort();
  };
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  if (callerSignal?.aborted === true) {
    controller.abort();
  }

  return {
    signal: controller.signal,
    errorFor: (details) =>
      expired
        ? new SafeFetchError(
            'timeout',
            `request exceeded the ${totalTimeoutMs} ms total budget`,
            details,
          )
        : (callerSignal?.reason ?? new SafeFetchError('timeout', 'request aborted', details)),
    release: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/**
 * Holds `work` to the deadline. Name resolution is not cancellable, so without
 * this a slow resolver would let a call outlive `totalTimeoutMs`.
 */
async function withDeadline<T>(work: Promise<T>, deadline: Deadline, hop: number): Promise<T> {
  if (deadline.signal.aborted) {
    throw deadline.errorFor({ hop });
  }

  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(deadline.errorFor({ hop }));
        deadline.signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort !== undefined) {
      deadline.signal.removeEventListener('abort', onAbort);
    }
  }
}

async function fetchFollowingRedirects(
  url: string | URL,
  init: SafeFetchInit,
  policy: ResolvedPolicy,
  deadline: Deadline,
): Promise<SafeFetchResponse> {
  const body = toBuffer(init.body);
  let plan: HopPlan = {
    method: normalizeMethod(init.method ?? 'GET'),
    headers: withBodyHeaders(normalizeHeaders(init.headers), body),
    body,
  };

  const redirects: string[] = [];
  let current: string | URL = url;

  for (let hop = 0; ; hop += 1) {
    const destination = await withDeadline(prepareHop(current, policy, hop), deadline, hop);
    const target = destination.target;

    const result = await performHop({
      destination,
      method: plan.method,
      headers: plan.headers,
      body: plan.body,
      policy,
      hop,
      signal: deadline.signal,
      abortError: (details) => deadline.errorFor(details),
    });

    if (result.location === undefined) {
      return {
        status: result.status,
        headers: result.headers,
        body: result.body,
        url: target.url.href,
        redirects,
      };
    }

    if (redirects.length >= policy.maxRedirects) {
      throw new SafeFetchError(
        'too-many-redirects',
        `more than ${policy.maxRedirects} redirects, starting at ${String(url)}`,
        { url: target.url.href, host: target.hostname, address: destination.address, hop },
      );
    }

    const next = URL.parse(result.location, target.url.href);
    if (next === null) {
      throw asRedirectBlocked(
        new SafeFetchError(
          'invalid-url',
          `redirect to an unparseable location from ${target.url.href}`,
          { url: target.url.href, host: target.hostname, hop: hop + 1 },
        ),
      );
    }

    redirects.push(next.href);
    plan = planRedirect({
      status: result.status,
      previous: plan,
      sameOrigin: next.origin === target.url.origin,
    });
    current = next;
  }
}

/**
 * Fetches a URL under the outbound-safety rules.
 *
 * @throws {SafeFetchError} for every request outcome that is not a response.
 * @throws {TypeError} when the policy or the init itself is malformed.
 */
export async function safeFetch(
  url: string | URL,
  init: SafeFetchInit = {},
  policy: SafeFetchPolicy = {},
): Promise<SafeFetchResponse> {
  const resolved = resolvePolicy(policy);
  const deadline = startDeadline(resolved.totalTimeoutMs, init.signal);

  try {
    return await fetchFollowingRedirects(url, init, resolved, deadline);
  } catch (error) {
    if (error instanceof SafeFetchError && BLOCKED_CODES.has(error.code)) {
      reportBlocked(resolved, blockedEvent(error));
    }
    throw error;
  } finally {
    deadline.release();
  }
}
