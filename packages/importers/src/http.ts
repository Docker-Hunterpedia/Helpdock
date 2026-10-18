import {
  type SafeFetchInit,
  type SafeFetchPolicy,
  type SafeFetchResponse,
  safeFetch,
} from '@helpdock/net';
import { z } from 'zod';
import { ConnectorError, RateLimited } from './errors.js';
import { type ImportRateLimiter, retryAfterMs } from './rate-limiter.js';
import { isInvalidUtf8 } from './utf8.js';

type RequestOptions = { followRedirects?: boolean };

export interface ImportPageCache {
  read(url: string): Promise<SafeFetchResponse | undefined>;
  write(url: string, response: SafeFetchResponse): Promise<SafeFetchResponse>;
}

export class ImportHttp {
  constructor(
    private readonly options: {
      cache?: ImportPageCache;
      dailyCreditLimit?: boolean;
      hosts: readonly string[];
      limiter: ImportRateLimiter;
      policy: SafeFetchPolicy;
    },
  ) {}

  withPageCache(cache: ImportPageCache): ImportHttp {
    return new ImportHttp({ ...this.options, cache });
  }

  async request(
    url: string,
    init: SafeFetchInit = {},
    options: RequestOptions = {},
  ): Promise<SafeFetchResponse> {
    init.signal?.throwIfAborted();
    const address = new URL(url);
    const cache =
      (init.method ?? 'GET').toUpperCase() === 'GET' &&
      init.body === undefined &&
      this.options.hosts.includes(address.hostname)
        ? this.options.cache
        : undefined;
    const cached = await cache?.read(address.href);
    if (cached) return cached;
    this.options.limiter.reserve();
    const response = await safeFetch(url, init, {
      ...this.options.policy,
      ...(options.followRedirects === false ? { maxRedirects: 0 } : {}),
      allowedHosts: this.options.hosts,
      totalTimeoutMs: 30000,
      maxBodyBytes: Math.min(
        this.options.policy.maxBodyBytes ?? 10 * 1024 * 1024,
        50 * 1024 * 1024,
      ),
    });
    if (response.status === 429) {
      const header = response.headers['retry-after'];
      const rawRetry = Array.isArray(header) ? header[0] : header;
      const remaining = response.headers['x-rate-limit-remaining-v3'];
      let dailyLimit = (Array.isArray(remaining) ? remaining[0] : remaining)?.trim() === '0';
      if (this.options.dailyCreditLimit && response.body.length < 16384) {
        try {
          const error = z
            .object({ errorCode: z.string() })
            .safeParse(JSON.parse(response.body.toString('utf8')));
          dailyLimit ||= error.success && error.data.errorCode === 'THRESHOLD_EXCEEDED';
        } catch {
          /* Invalid error bodies still defer without retaining vendor text. */
        }
      }
      // Respect a provided deadline. Without one, daily exhaustion waits through
      // a complete data-center day rather than probing the exhausted account each second.
      const delay = retryAfterMs(
        rawRetry,
        Date.now(),
        this.options.dailyCreditLimit && dailyLimit ? 86400000 : 1000,
      );
      this.options.limiter.defer(delay);
      throw new RateLimited(delay);
    }
    if ([401, 403].includes(response.status))
      throw new ConnectorError(
        'credentials-refused',
        response.status,
        new URL(response.url).origin,
      );
    if ([404, 410].includes(response.status))
      throw new ConnectorError('record-unavailable', response.status, new URL(response.url).origin);
    if (response.status >= 500) throw new ConnectorError('vendor-unavailable', response.status);
    if (response.status < 200 || response.status >= 300)
      throw new ConnectorError('invalid-response', response.status);
    return cache ? cache.write(address.href, response) : response;
  }

  async json<T>(
    url: string,
    schema: z.ZodType<T>,
    init: SafeFetchInit = {},
    options: RequestOptions = {},
  ): Promise<T> {
    return (await this.jsonResponse(url, schema, init, options)).data;
  }

  async jsonResponse<T>(
    url: string,
    schema: z.ZodType<T>,
    init: SafeFetchInit = {},
    options: RequestOptions = {},
  ): Promise<{ data: T; headers: SafeFetchResponse['headers'] }> {
    const response = await this.request(url, init, options);
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
    } catch (error) {
      if (error instanceof SyntaxError || isInvalidUtf8(error))
        throw new ConnectorError('invalid-response');
      throw error;
    }
    const parsed = schema.safeParse(decoded);
    if (!parsed.success) throw new ConnectorError('invalid-response');
    return { data: parsed.data, headers: response.headers };
  }
}
