/**
 * Behavioural tests against a real `node:http` server on 127.0.0.1.
 *
 * Nothing here reaches the internet: every hostname is resolved by an injected
 * `policy.lookup`, and loopback is reachable only because the test policy
 * allow-lists `127.0.0.0/8` the way an operator would allow an internal proxy.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SafeFetchError } from './errors.js';
import type { LookupAddress, SafeFetchPolicy } from './policy.js';
import { planRedirect, safeFetch } from './safe-fetch.js';

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

const CHUNK = Buffer.alloc(64 * 1024, 0x61);
const BIG_BODY_BYTES = 4 * 1024 * 1024;

let server: Server;
let port = 0;
let requests: RecordedRequest[] = [];
const sockets = new Set<Socket>();

function url(path: string, host = 'primary.test'): string {
  return `http://${host}:${port}${path}`;
}

const lookup = vi.fn(
  async (hostname: string): Promise<readonly LookupAddress[]> =>
    hostname === 'blocked.test'
      ? [{ address: '10.0.0.1', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }],
);

function localPolicy(extra: SafeFetchPolicy = {}): SafeFetchPolicy {
  return { allowedPorts: [port], allowCidrs: ['127.0.0.0/8'], lookup, ...extra };
}

async function caught(promise: Promise<unknown>): Promise<SafeFetchError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(SafeFetchError);
  return error as SafeFetchError;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    response.on('error', () => {
      // The client destroys the socket on a size cap or a timeout; the server
      // side of that is not what these tests are asserting on.
    });

    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = request.url ?? '/';
      requests.push({
        method: request.method ?? '',
        path,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });

      switch (path) {
        case '/hello':
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.end('hello');
          return;
        case '/same-host-redirect':
          response.writeHead(302, { location: '/hello' });
          response.end();
          return;
        case '/cross-host-redirect':
          response.writeHead(302, { location: url('/hello', 'secondary.test') });
          response.end();
          return;
        case '/see-other':
          response.writeHead(303, { location: '/hello' });
          response.end();
          return;
        case '/temporary':
          response.writeHead(307, { location: '/hello' });
          response.end();
          return;
        case '/loop':
          response.writeHead(302, { location: '/loop' });
          response.end();
          return;
        case '/to-blocked':
          response.writeHead(302, { location: url('/hello', 'blocked.test') });
          response.end();
          return;
        case '/declared-big':
          response.writeHead(200, { 'content-length': '5000' });
          response.end(Buffer.alloc(5000, 0x62));
          return;
        case '/big': {
          response.writeHead(200, { 'content-type': 'application/octet-stream' });
          let sent = 0;
          const pump = (): void => {
            while (sent < BIG_BODY_BYTES) {
              sent += CHUNK.length;
              if (!response.write(CHUNK)) {
                response.once('drain', pump);
                return;
              }
            }
            response.end();
          };
          pump();
          return;
        }
        case '/truncated':
          response.writeHead(200, { 'content-length': '100' });
          response.write('partial');
          response.socket?.destroy();
          return;
        case '/stall':
          return;
        default:
          response.writeHead(404);
          response.end();
      }
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(() => {
  requests = [];
  lookup.mockClear();
});

describe('safeFetch, successful requests', () => {
  it('performs a GET and returns the status, headers and body', async () => {
    const response = await safeFetch(url('/hello'), {}, localPolicy());

    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe('hello');
    expect(response.headers['content-type']).toBe('text/plain');
    expect(response.url).toBe(url('/hello'));
    expect(response.redirects).toEqual([]);
  });

  it('sends the original hostname as Host while connecting to the resolved address', async () => {
    await safeFetch(url('/hello'), {}, localPolicy());

    expect(requests[0]?.headers.host).toBe(`primary.test:${port}`);
    expect(lookup).toHaveBeenCalledWith('primary.test');
  });

  it('performs a POST with a body and a content length', async () => {
    const response = await safeFetch(
      url('/hello'),
      { method: 'post', body: 'ping', headers: { 'Content-Type': 'text/plain' } },
      localPolicy(),
    );

    expect(response.status).toBe(200);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.body).toBe('ping');
    expect(requests[0]?.headers['content-length']).toBe('4');
    expect(requests[0]?.headers['content-type']).toBe('text/plain');
  });

  it('accepts a literal loopback address when the operator allow-lists it', async () => {
    const response = await safeFetch(url('/hello', '127.0.0.1'), {}, localPolicy());

    expect(response.status).toBe(200);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('ignores a caller-supplied Host header', async () => {
    await safeFetch(url('/hello'), { headers: { host: 'evil.test' } }, localPolicy());

    expect(requests[0]?.headers.host).toBe(`primary.test:${port}`);
  });
});

describe('safeFetch, refused destinations', () => {
  it('blocks loopback when nothing is allow-listed, and reports it', async () => {
    const onBlocked = vi.fn();
    const error = await caught(
      safeFetch(url('/hello', '127.0.0.1'), {}, { allowedPorts: [port], lookup, onBlocked }),
    );

    expect(error.code).toBe('destination-blocked');
    expect(error.address).toBe('127.0.0.1');
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(onBlocked.mock.calls[0]?.[0]).toMatchObject({
      code: 'destination-blocked',
      host: '127.0.0.1',
      address: '127.0.0.1',
      hop: 0,
    });
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['ftp://example.com/x', 'scheme-not-allowed'],
    ['http://user:secret@primary.test/x', 'credentials-in-url'],
    ['not a url', 'invalid-url'],
  ])('refuses %s before opening a socket', async (target, code) => {
    const error = await caught(safeFetch(target, {}, localPolicy()));

    expect(error.code).toBe(code);
    expect(requests).toHaveLength(0);
  });

  it('refuses a port the policy does not allow', async () => {
    const error = await caught(
      safeFetch(url('/hello'), {}, { ...localPolicy(), allowedPorts: [80] }),
    );

    expect(error.code).toBe('port-not-allowed');
    expect(requests).toHaveLength(0);
  });
});

describe('safeFetch, redirects', () => {
  it('follows a same-host redirect and keeps the credentials', async () => {
    const response = await safeFetch(
      url('/same-host-redirect'),
      { headers: { authorization: 'Bearer token', cookie: 'sid=1' } },
      localPolicy(),
    );

    expect(response.status).toBe(200);
    expect(response.url).toBe(url('/hello'));
    expect(response.redirects).toEqual([url('/hello')]);
    expect(requests[1]?.headers.authorization).toBe('Bearer token');
    expect(requests[1]?.headers.cookie).toBe('sid=1');
  });

  it('strips Authorization and Cookie when the redirect changes host', async () => {
    const response = await safeFetch(
      url('/cross-host-redirect'),
      { headers: { authorization: 'Bearer token', cookie: 'sid=1' } },
      localPolicy(),
    );

    expect(response.status).toBe(200);
    expect(response.redirects).toEqual([url('/hello', 'secondary.test')]);
    expect(requests[0]?.headers.authorization).toBe('Bearer token');
    expect(requests[1]?.headers.host).toBe(`secondary.test:${port}`);
    expect(requests[1]?.headers.authorization).toBeUndefined();
    expect(requests[1]?.headers.cookie).toBeUndefined();
  });

  it('turns a POST into a GET on 303 and drops the body', async () => {
    await safeFetch(url('/see-other'), { method: 'POST', body: 'payload' }, localPolicy());

    expect(requests[0]?.method).toBe('POST');
    expect(requests[1]?.method).toBe('GET');
    expect(requests[1]?.body).toBe('');
    expect(requests[1]?.headers['content-length']).toBeUndefined();
  });

  it('keeps the method and the body on 307', async () => {
    await safeFetch(url('/temporary'), { method: 'POST', body: 'payload' }, localPolicy());

    expect(requests[1]?.method).toBe('POST');
    expect(requests[1]?.body).toBe('payload');
  });

  it('gives up after maxRedirects hops', async () => {
    const error = await caught(safeFetch(url('/loop'), {}, localPolicy({ maxRedirects: 2 })));

    expect(error.code).toBe('too-many-redirects');
    expect(requests).toHaveLength(3);
  });

  it('rejects any redirect when maxRedirects is zero', async () => {
    const error = await caught(
      safeFetch(url('/same-host-redirect'), {}, localPolicy({ maxRedirects: 0 })),
    );

    expect(error.code).toBe('too-many-redirects');
  });

  it('re-checks the destination on every hop and names the hop it blocked', async () => {
    const onBlocked = vi.fn();
    const error = await caught(safeFetch(url('/to-blocked'), {}, localPolicy({ onBlocked })));

    expect(error.code).toBe('redirect-blocked');
    expect(error.reason).toBe('destination-blocked');
    expect(error.hop).toBe(1);
    expect(error.address).toBe('10.0.0.1');
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });
});

describe('safeFetch, budgets', () => {
  it('stops a body that outgrows the cap mid-stream', async () => {
    const error = await caught(safeFetch(url('/big'), {}, localPolicy({ maxBodyBytes: 1024 })));

    expect(error.code).toBe('body-too-large');
    expect(error.message).toContain('1024 byte cap');
  });

  it('refuses a body whose declared length is already over the cap', async () => {
    const error = await caught(
      safeFetch(url('/declared-big'), {}, localPolicy({ maxBodyBytes: 1000 })),
    );

    expect(error.code).toBe('body-too-large');
    expect(error.message).toContain('5000 bytes');
  });

  it('gives up on a server that never answers', async () => {
    const error = await caught(safeFetch(url('/stall'), {}, localPolicy({ totalTimeoutMs: 150 })));

    expect(error.code).toBe('timeout');
    expect(error.message).toContain('150 ms total budget');
  });

  it('holds a resolver that never answers to the total budget', async () => {
    const hanging = vi.fn(() => new Promise<readonly LookupAddress[]>(() => undefined));

    const error = await caught(
      safeFetch(url('/hello'), {}, localPolicy({ lookup: hanging, totalTimeoutMs: 120 })),
    );

    expect(error.code).toBe('timeout');
    expect(requests).toHaveLength(0);
  });

  it('surrenders to the caller signal with the caller reason', async () => {
    const controller = new AbortController();
    const reason = new Error('caller changed its mind');
    const pending = safeFetch(url('/stall'), { signal: controller.signal }, localPolicy());

    setTimeout(() => controller.abort(reason), 20);

    await expect(pending).rejects.toBe(reason);
  });

  it('refuses to start when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      safeFetch(url('/hello'), { signal: controller.signal }, localPolicy()),
    ).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});

describe('safeFetch, network failures', () => {
  it('reports a refused connection as a network error naming the destination', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => {
      closed.listen(0, '127.0.0.1', resolve);
    });
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
      closed.close(() => resolve());
    });

    const error = await caught(
      safeFetch(
        `http://primary.test:${closedPort}/hello`,
        {},
        localPolicy({ allowedPorts: [closedPort] }),
      ),
    );

    expect(error.code).toBe('network-error');
    expect(error.host).toBe('primary.test');
    expect(error.address).toBe('127.0.0.1');
  });

  it('reports a connection cut mid-body as a network error', async () => {
    const error = await caught(safeFetch(url('/truncated'), {}, localPolicy()));

    expect(error.code).toBe('network-error');
  });
});

describe('safeFetch, DNS rebinding', () => {
  it('connects to the address it validated, not to a later answer', async () => {
    const rebinding = vi.fn(async () => {
      const answer: readonly LookupAddress[] =
        rebinding.mock.calls.length === 1
          ? [{ address: '127.0.0.1', family: 4 }]
          : [{ address: '203.0.113.9', family: 4 }];
      return answer;
    });

    const response = await safeFetch(url('/hello'), {}, localPolicy({ lookup: rebinding }));

    expect(response.status).toBe(200);
    expect(rebinding).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  it('blocks on the first answer even when a later answer would be allowed', async () => {
    const rebinding = vi.fn(async () => {
      const answer: readonly LookupAddress[] =
        rebinding.mock.calls.length === 1
          ? [{ address: '10.0.0.1', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }];
      return answer;
    });

    const error = await caught(safeFetch(url('/hello'), {}, localPolicy({ lookup: rebinding })));

    expect(error.code).toBe('destination-blocked');
    expect(error.address).toBe('10.0.0.1');
    expect(rebinding).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(0);
  });
});

describe('planRedirect', () => {
  const previous = {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-length': '4', 'content-type': 'text/plain' },
    body: Buffer.from('ping'),
  };

  it.each([301, 302, 303])('downgrades a POST to a GET on %i', (status) => {
    const plan = planRedirect({ status, previous, sameOrigin: true });

    expect(plan.method).toBe('GET');
    expect(plan.body).toBeUndefined();
    expect(plan.headers['content-length']).toBeUndefined();
    expect(plan.headers['content-type']).toBeUndefined();
  });

  it.each([307, 308])('keeps the method and the body on %i', (status) => {
    const plan = planRedirect({ status, previous, sameOrigin: true });

    expect(plan.method).toBe('POST');
    expect(plan.body?.toString('utf8')).toBe('ping');
    expect(plan.headers['content-length']).toBe('4');
  });

  it('leaves a GET alone on 301', () => {
    const plan = planRedirect({
      status: 301,
      previous: { method: 'GET', headers: {}, body: undefined },
      sameOrigin: true,
    });

    expect(plan.method).toBe('GET');
  });

  it('leaves a HEAD alone on 303', () => {
    const plan = planRedirect({
      status: 303,
      previous: { method: 'HEAD', headers: {}, body: undefined },
      sameOrigin: true,
    });

    expect(plan.method).toBe('HEAD');
  });
});

describe('safeFetch, argument validation', () => {
  it('rejects a method that is not an HTTP token', async () => {
    await expect(safeFetch(url('/hello'), { method: 'BAD METHOD' }, localPolicy())).rejects.toThrow(
      TypeError,
    );
  });
});
