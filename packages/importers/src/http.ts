import {
  type SafeFetchInit,
  type SafeFetchPolicy,
  type SafeFetchResponse,
  safeFetch,
} from '@helpdock/net';
import type { z } from 'zod';
import { ConnectorError, RateLimited } from './errors.js';
import { type ImportRateLimiter, retryAfterMs } from './rate-limiter.js';
import { isInvalidUtf8 } from './utf8.js';

type RequestOptions = { followRedirects?: boolean };

export class ImportHttp {
  constructor(
    private readonly options: {
      hosts: readonly string[];
      limiter: ImportRateLimiter;
      policy: SafeFetchPolicy;
    },
  ) {}

  async request(
    url: string,
    init: SafeFetchInit = {},
    options: RequestOptions = {},
  ): Promise<SafeFetchResponse> {
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
      const delay = retryAfterMs(Array.isArray(header) ? header[0] : header);
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
    return response;
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
