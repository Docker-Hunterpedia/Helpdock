import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Env } from '@helpdock/config';
import { isUuid } from '@helpdock/db';
import type { DestinationStream } from 'pino';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../logging/logger.js';
import type { BrandResolver } from './brand-resolver.js';
import { NoopBrandResolver } from './brand-resolver.js';
import { currentRequestContext, type RequestContext } from './request-context.js';
import { RequestContextMiddleware } from './request-context.middleware.js';
import { REQUEST_ID_HEADER } from './request-id.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';

class FakeResponse extends EventEmitter {
  statusCode = 200;
  readonly headers: Record<string, string> = {};

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  finish(status = 200): void {
    this.statusCode = status;
    this.emit('finish');
  }
}

interface Line {
  readonly msg: string;
  readonly [key: string]: unknown;
}

const collector = (): { lines: Line[]; stream: DestinationStream } => {
  const lines: Line[] = [];
  return {
    lines,
    stream: {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Line);
      },
    },
  };
};

interface RunOptions {
  readonly url?: string;
  readonly originalUrl?: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly trustProxy?: boolean;
  readonly brandResolver?: BrandResolver;
  readonly stream?: DestinationStream;
}

const run = async ({
  url = '/',
  originalUrl,
  method = 'GET',
  headers = {},
  trustProxy = false,
  brandResolver = new NoopBrandResolver(),
  stream = collector().stream,
}: RunOptions = {}): Promise<{ context: RequestContext; response: FakeResponse }> => {
  const middleware = new RequestContextMiddleware(
    { TRUST_PROXY: trustProxy } as Env,
    createLogger({
      env: { APP_ROLE: 'api', NODE_ENV: 'test' },
      level: 'trace',
      destination: stream,
    }),
    brandResolver,
  );

  const response = new FakeResponse();
  const request = { url, originalUrl, method, headers } as unknown as IncomingMessage;

  return new Promise((resolve, reject) => {
    middleware.use(request, response as unknown as ServerResponse, (error?: unknown) => {
      if (error !== undefined) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      const context = currentRequestContext();
      if (context === undefined) {
        reject(new Error('the middleware did not enter the request context'));
        return;
      }
      resolve({ context, response });
    });
  });
};

describe('RequestContextMiddleware', () => {
  it('opens a context the rest of the request can read', async () => {
    const { context } = await run({ originalUrl: '/api/brands?q=secret', method: 'POST' });

    expect(isUuid(context.requestId)).toBe(true);
    expect(context.method).toBe('POST');
    expect(context.path).toBe('/api/brands');
  });

  it('prefers the url middie kept over the one it rewrote', async () => {
    const { context } = await run({ url: '/', originalUrl: '/api/me' });

    expect(context.path).toBe('/api/me');
  });

  it('falls back to the raw url when nothing kept the original', async () => {
    const { context } = await run({ url: '/health' });

    expect(context.path).toBe('/health');
  });

  it('echoes the request id so a client can quote it', async () => {
    const { context, response } = await run();

    expect(response.headers[REQUEST_ID_HEADER]).toBe(context.requestId);
  });

  it('takes the proxy request id only when the proxy is trusted', async () => {
    const headers = { [REQUEST_ID_HEADER]: 'caddy-1' };

    await expect(run({ headers, trustProxy: true })).resolves.toMatchObject({
      context: { requestId: 'caddy-1' },
    });
    const { context } = await run({ headers, trustProxy: false });
    expect(context.requestId).not.toBe('caddy-1');
  });

  it('resolves the brand from the host, when a resolver knows one', async () => {
    const seen: (string | undefined)[] = [];
    const resolver: BrandResolver = {
      resolve: (host) => {
        seen.push(host);
        return Promise.resolve({ brandId: BRAND, kind: 'helpcenter' });
      },
    };

    const { context } = await run({
      headers: { host: 'support.acme.test' },
      brandResolver: resolver,
    });

    expect(seen).toEqual(['support.acme.test']);
    expect(context.hostBrandId).toBe(BRAND);
  });

  it('leaves the brand unset when no host matches', async () => {
    const { context } = await run({ headers: { host: 'unknown.test' } });

    expect(context.hostBrandId).toBeNull();
  });

  it('hands a resolver failure to the error pipeline rather than serving without a brand', async () => {
    const resolver: BrandResolver = { resolve: () => Promise.reject(new Error('dns is down')) };

    await expect(run({ brandResolver: resolver })).rejects.toThrow('dns is down');
  });

  it('logs one line per request, with the id, the status and no query string', async () => {
    const { lines, stream } = collector();
    const { response, context } = await run({ originalUrl: '/api/brands?q=secret', stream });

    response.finish(403);

    expect(lines.at(-1)).toMatchObject({
      msg: 'request',
      requestId: context.requestId,
      method: 'GET',
      path: '/api/brands',
      status: 403,
      principalType: null,
    });
    expect(JSON.stringify(lines.at(-1))).not.toContain('secret');
  });
});
