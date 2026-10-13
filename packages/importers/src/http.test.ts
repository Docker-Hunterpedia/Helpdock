import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { ImportHttp } from './http.js';
import { ImportRateLimiter } from './rate-limiter.js';

let server: Server;
let origin: string;
let port: number;

beforeAll(async () => {
  server = createServer((request, response) => {
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
