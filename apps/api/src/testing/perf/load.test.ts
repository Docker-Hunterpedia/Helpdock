import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LoadScenario, runLoad } from './load.js';

/** Sends its headers at once and its body after `BODY_DELAY_MS`. */
const BODY_DELAY_MS = 120;

describe('runLoad', () => {
  let server: Server;
  let baseUrl: string;
  const seen: IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      seen.push(request.headers);
      response.writeHead(request.url === '/missing' ? 404 : 200, { 'content-type': 'text/plain' });
      response.flushHeaders();
      setTimeout(() => response.end('ok'), BODY_DELAY_MS);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const run = (scenarios: LoadScenario[], until?: 'body' | 'headers') =>
    runLoad({
      baseUrls: [baseUrl],
      scenarios,
      concurrency: 2,
      warmupMs: 0,
      durationMs: 600,
      thinkMs: 0,
      ...(until === undefined ? {} : { until }),
    });

  it('times the whole response by default, and only to the headers when asked', async () => {
    const visitor = { label: 'visitor', token: null };
    const page: LoadScenario[] = [{ name: 'page', session: visitor, path: '/a' }];

    const body = await run(page);
    const headers = await run(page, 'headers');

    expect(body.overall.p50).toBeGreaterThanOrEqual(BODY_DELAY_MS - 10);
    expect(headers.overall.p50).toBeLessThan(BODY_DELAY_MS / 2);
  });

  it('reports scenarios of one session that share a name as one, and counts what was not 200', async () => {
    const visitor = { label: 'visitor', token: null };
    const result = await run([
      { name: 'article', session: visitor, path: '/a' },
      { name: 'article', session: visitor, path: '/b' },
      { name: 'gone', session: visitor, path: '/missing' },
    ]);

    expect(result.scenarios.map((scenario) => scenario.name)).toEqual(['article', 'gone']);
    expect(result.scenarios[1]?.errors).toBe(result.scenarios[1]?.count);
    expect(result.scenarios[0]?.errors).toBe(0);
  });

  it('sends a bearer token for staff and nothing for a visitor', async () => {
    seen.length = 0;
    await run([
      { name: 'staff', session: { label: 'admin', token: 'abc' }, path: '/a' },
      { name: 'visitor', session: { label: 'visitor', token: null }, path: '/a' },
    ]);

    const authorizations = new Set(seen.map((headers) => headers.authorization));
    expect(authorizations).toEqual(new Set(['Bearer abc', undefined]));
  });
});
