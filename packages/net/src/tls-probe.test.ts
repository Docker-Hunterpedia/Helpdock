import { EventEmitter } from 'node:events';
import type { ConnectionOptions, PeerCertificate } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LookupFunction } from './policy.js';
import { type ProbeSocket, probeTls } from './tls-probe.js';

const lookupTo =
  (address: string): LookupFunction =>
  () =>
    Promise.resolve([{ address, family: 4 }]);

const PUBLIC = lookupTo('93.184.216.34');

interface FakeSocket extends ProbeSocket {
  emit(event: string, ...args: unknown[]): boolean;
  destroyed: boolean;
}

/** A socket double: the test decides which event it emits and what it says about the chain. */
const fakeSocket = (state: {
  authorized?: boolean;
  authorizationError?: Error | string;
  validTo?: string;
}): FakeSocket => {
  const emitter = new EventEmitter();
  const socket = {
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
    destroyed: false,
    destroy() {
      socket.destroyed = true;
      return socket;
    },
    authorized: state.authorized ?? false,
    authorizationError: state.authorizationError,
    getPeerCertificate: () => ({ valid_to: state.validTo ?? '' }) as PeerCertificate,
  };
  return socket as unknown as FakeSocket;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('probeTls', () => {
  it('connects to the resolved address and keeps the name for SNI', async () => {
    const socket = fakeSocket({ authorized: true, validTo: 'Dec 20 10:00:00 2026 GMT' });
    let seen: ConnectionOptions | undefined;
    const probe = probeTls('help.acme.com', {
      lookup: PUBLIC,
      connect: (options) => {
        seen = options;
        queueMicrotask(() => socket.emit('secureConnect'));
        return socket;
      },
    });

    await expect(probe).resolves.toEqual({
      status: 'valid',
      validTo: new Date('2026-12-20T10:00:00Z'),
    });
    expect(seen).toMatchObject({ host: '93.184.216.34', port: 443, servername: 'help.acme.com' });
    expect(socket.destroyed).toBe(true);
  });

  it('reports a certificate the chain check refused, with the reason', async () => {
    const socket = fakeSocket({ authorized: false, authorizationError: 'SELF_SIGNED_CERT' });

    const result = await probeTls('help.acme.com', {
      lookup: PUBLIC,
      port: 8443,
      connect: () => {
        queueMicrotask(() => socket.emit('secureConnect'));
        return socket;
      },
    });

    expect(result).toEqual({ status: 'invalid', code: 'SELF_SIGNED_CERT' });
  });

  it('names an unauthorised chain without a reason as untrusted', async () => {
    const socket = fakeSocket({ authorized: false });

    const result = await probeTls('help.acme.com', {
      lookup: PUBLIC,
      connect: () => {
        queueMicrotask(() => socket.emit('secureConnect'));
        return socket;
      },
    });

    expect(result).toEqual({ status: 'invalid', code: 'untrusted' });
  });

  it('reports a refused connection by its code', async () => {
    const socket = fakeSocket({});

    const result = await probeTls('help.acme.com', {
      lookup: PUBLIC,
      connect: () => {
        queueMicrotask(() => {
          socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
          // A second event after the first answer changes nothing.
          socket.emit('secureConnect');
        });
        return socket;
      },
    });

    expect(result).toEqual({ status: 'unreachable', code: 'ECONNREFUSED' });
  });

  it('names an error without a code as a network error', async () => {
    const socket = fakeSocket({});

    const result = await probeTls('help.acme.com', {
      lookup: PUBLIC,
      connect: () => {
        queueMicrotask(() => socket.emit('error', new Error('reset')));
        return socket;
      },
    });

    expect(result).toEqual({ status: 'unreachable', code: 'network-error' });
  });

  it('gives up when no handshake completes in time', async () => {
    vi.useFakeTimers();
    const socket = fakeSocket({});

    const probe = probeTls('help.acme.com', {
      lookup: PUBLIC,
      timeoutMs: 1_000,
      connect: () => socket,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(probe).resolves.toEqual({ status: 'unreachable', code: 'timeout' });
    expect(socket.destroyed).toBe(true);
  });

  it('never connects to a private address', async () => {
    const connect = vi.fn();

    const result = await probeTls('help.acme.com', { lookup: lookupTo('10.0.0.5'), connect });

    expect(result).toEqual({ status: 'unreachable', code: 'destination-blocked' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('reports a name that does not resolve', async () => {
    const result = await probeTls('help.acme.com', {
      lookup: () => Promise.reject(new Error('ENOTFOUND')),
      connect: vi.fn(),
    });

    expect(result).toEqual({ status: 'unreachable', code: 'dns-failure' });
  });
});
