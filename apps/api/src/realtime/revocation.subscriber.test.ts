import type { Principal } from '@helpdock/schemas';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../testing/silent-logger.js';
import { RevocationSubscriber } from './revocation.subscriber.js';
import type { StaffSocket } from './socket.js';
import { SocketRegistry } from './socket-registry.js';

const LINA = '01937f5e-7e53-7000-8000-000000000001';
const OMAR = '01937f5e-7e53-7000-8000-000000000002';

const principal = (id: string): Principal => ({
  type: 'staff',
  id,
  brands: {},
  installAdmin: false,
});

interface FakeSocket {
  readonly id: string;
  readonly emitted: { event: string; payload: unknown }[];
  disconnected: boolean;
}

const socketOf = (id: string, userId: string): StaffSocket & FakeSocket => {
  const socket = {
    id,
    emitted: [] as { event: string; payload: unknown }[],
    disconnected: false,
    data: {
      principal: principal(userId),
      sessionId: `sid-${id}`,
      familyId: `fam-${id}`,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      brandIds: new Set<string>(),
    },
    emit(event: string, payload: unknown) {
      socket.emitted.push({ event, payload });
    },
    disconnect() {
      socket.disconnected = true;
    },
  };

  // biome-ignore lint/suspicious/noExplicitAny: the subscriber uses emit, disconnect and data.
  return socket as any;
};

const subscriberWith = (registry: SocketRegistry, logger = silentLogger()) =>
  new RevocationSubscriber({} as Redis, registry, logger);

describe('RevocationSubscriber', () => {
  it('disconnects every socket of the revoked principal and no one else', () => {
    const registry = new SocketRegistry();
    const first = socketOf('s1', LINA);
    const second = socketOf('s2', LINA);
    const other = socketOf('s3', OMAR);
    for (const socket of [first, second, other]) {
      registry.add(socket);
    }

    subscriberWith(registry).disconnectRevoked(
      JSON.stringify({ principalType: 'staff', principalId: LINA, reason: 'signed-out' }),
    );

    expect([first.disconnected, second.disconnected, other.disconnected]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('says why before it closes, so the client stops instead of reconnecting', () => {
    const registry = new SocketRegistry();
    const socket = socketOf('s1', LINA);
    registry.add(socket);

    subscriberWith(registry).disconnectRevoked(
      JSON.stringify({ principalType: 'staff', principalId: LINA, reason: 'role-change' }),
    );

    expect(socket.emitted).toEqual([
      { event: 'revoked', payload: { code: 'session_revoked', message: 'role-change' } },
    ]);
  });

  it.each([
    ['text that is not JSON', 'not json'],
    [
      'a principal id that is not a uuid',
      JSON.stringify({ principalType: 'staff', principalId: 'x', reason: 'r' }),
    ],
    ['a message with no reason', JSON.stringify({ principalType: 'staff', principalId: LINA })],
  ])('ignores %s, because anything with PUBLISH can write to the channel', (_name, message) => {
    const registry = new SocketRegistry();
    const socket = socketOf('s1', LINA);
    registry.add(socket);
    const logger = silentLogger();
    const warn = vi.spyOn(logger, 'warn');

    subscriberWith(registry, logger).disconnectRevoked(message);

    expect(socket.disconnected).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('does nothing when this replica holds none of that person’s sockets', () => {
    const registry = new SocketRegistry();
    const logger = silentLogger();
    const info = vi.spyOn(logger, 'info');

    subscriberWith(registry, logger).disconnectRevoked(
      JSON.stringify({ principalType: 'staff', principalId: LINA, reason: 'signed-out' }),
    );

    expect(info).not.toHaveBeenCalled();
  });
});
