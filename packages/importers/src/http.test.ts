import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SafeFetchResponse } from '@helpdock/net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { ImportHttp, type ImportPageCache, RUN_SNAPSHOT } from './http.js';
import { ImportRateLimiter } from './rate-limiter.js';

let server: Server;
let origin: string;
let port: number;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/malformed-utf8') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        Buffer.concat([Buffer.from('{"account":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]),
      );
      return;
    }
    const status = Number(request.url?.slice(1)) || 200;
    response.writeHead(status, { 'content-type': 'application/json', 'retry-after': '12' });
    response.end(status === 200 ? JSON.stringify({ account: 'Sandbox' }) : 'provider secret error');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function client() {
  return new ImportHttp({
    hosts: ['127.0.0.1'],
    limiter: new ImportRateLimiter({ capacity: 10, perMinute: 100 }),
    policy: { allowedPorts: [port], allowCidrs: ['127.0.0.1/32'] },
  });
}

it('validates successful vendor JSON before returning it to a connector', async () => {
  expect(await client().json(`${origin}/200`, z.object({ account: z.string() }))).toEqual({
    account: 'Sandbox',
  });
  await expect(
    client().json(`${origin}/200`, z.object({ tickets: z.array(z.object({ id: z.string() })) })),
  ).rejects.toMatchObject({ code: 'invalid-response' });
});

it('rejects corrupted vendor text rather than saving replacement characters', async () => {
  await expect(
    client().json(`${origin}/malformed-utf8`, z.object({ account: z.string() })),
  ).rejects.toMatchObject({ code: 'invalid-response', message: 'invalid-response' });
});

it('honours vendor Retry-After and keeps the transport blocked until its retry time', async () => {
  const http = client();
  await expect(http.request(`${origin}/429`)).rejects.toMatchObject({ retryAfterMs: 12000 });
  await expect(http.request(`${origin}/200`)).rejects.toMatchObject({ name: 'RateLimited' });
});

it.each([
  [401, 'credentials-refused'],
  [403, 'credentials-refused'],
  [404, 'record-unavailable'],
  [410, 'record-unavailable'],
  [503, 'vendor-unavailable'],
])('maps HTTP %i to a safe import failure', async (status, code) => {
  await expect(client().request(`${origin}/${status}`)).rejects.toMatchObject({
    code,
    message: code,
    status,
  });
});

it('passes the requested snapshot scope to the page cache on a miss and on a hit', async () => {
  const stored = new Map<string, SafeFetchResponse>();
  const calls: unknown[][] = [];
  const cache: ImportPageCache = {
    read: async (url, scope) => {
      calls.push(['read', url, scope]);
      return stored.get(url);
    },
    write: async (url, response, scope) => {
      calls.push(['write', url, scope]);
      stored.set(url, response);
      return response;
    },
  };
  const http = client().withPageCache(cache);
  const slot = { slot: 'zendesk.comments' };
  const url = `${origin}/200`;
  await http.request(url, {}, { snapshot: slot });
  await http.request(url, {}, { snapshot: RUN_SNAPSHOT });
  await http.request(url);
  expect(calls).toEqual([
    ['read', url, slot],
    ['write', url, slot],
    ['read', url, RUN_SNAPSHOT],
    ['read', url, undefined],
  ]);
});
