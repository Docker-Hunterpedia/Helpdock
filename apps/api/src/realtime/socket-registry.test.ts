import type { Principal } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { InMemorySocketConnectionsGauge } from './metrics.js';
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

const socketOf = (id: string, userId: string): StaffSocket =>
  ({
    id,
    data: {
      principal: principal(userId),
      sessionId: `sid-${id}`,
      familyId: `fam-${id}`,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      brandIds: new Set<string>(),
    },
    // biome-ignore lint/suspicious/noExplicitAny: the registry reads `data` and nothing else.
  }) as any;

describe('SocketRegistry', () => {
  it('finds every socket of one person and leaves the others alone', () => {
    const registry = new SocketRegistry();
    const first = socketOf('s1', LINA);
    const second = socketOf('s2', LINA);
    registry.add(first);
    registry.add(second);
    registry.add(socketOf('s3', OMAR));

    expect(registry.socketsOf(LINA)).toEqual([first, second]);
    expect(registry.socketsOf(OMAR)).toHaveLength(1);
    expect(registry.size()).toBe(3);
  });

  it('answers with a copy, so a caller may disconnect while iterating', () => {
    const registry = new SocketRegistry();
    const socket = socketOf('s1', LINA);
    registry.add(socket);

    for (const held of registry.socketsOf(LINA)) {
      registry.remove(held);
    }

    expect(registry.socketsOf(LINA)).toEqual([]);
    expect(registry.size()).toBe(0);
  });

  it('shrugs at a socket it never held', () => {
    const registry = new SocketRegistry();

    expect(() => {
      registry.remove(socketOf('s1', LINA));
    }).not.toThrow();
  });

  it('answers nothing for someone with no sockets here', () => {
    expect(new SocketRegistry().socketsOf(LINA)).toEqual([]);
  });
});

describe('InMemorySocketConnectionsGauge', () => {
  it('reports zero for a namespace nobody has connected to', () => {
    expect(new InMemorySocketConnectionsGauge().get('/staff')).toBe(0);
  });

  it('keeps one value per namespace, so M4 can add /widget beside /staff', () => {
    const gauge = new InMemorySocketConnectionsGauge();
    gauge.set({ namespace: '/staff' }, 3);
    gauge.set({ namespace: '/widget' }, 11);
    gauge.set({ namespace: '/staff' }, 2);

    expect(gauge.snapshot()).toEqual({ '/staff': 2, '/widget': 11 });
  });
});
