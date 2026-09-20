import {
  brandRoom,
  departmentRoom,
  type Principal,
  STAFF_NAMESPACE,
  ticketRoom,
} from '@helpdock/schemas';
import type { Namespace } from 'socket.io';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisStub } from '../testing/redis-stub.js';
import { silentLogger } from '../testing/silent-logger.js';
import type { SocketSession } from './handshake.js';
import { InMemorySocketConnectionsGauge } from './metrics.js';
import { PresenceService } from './presence.service.js';
import { PresenceStore } from './presence.store.js';
import { RealtimePublisher } from './publisher.js';
import type { RoomScopeReader } from './room-reader.js';
import { HandshakeRefusal, type StaffSocket } from './socket.js';
import { SocketRegistry } from './socket-registry.js';
import { StaffGateway } from './staff.gateway.js';
import { NoopStaffOfflineHook } from './staff-offline.hook.js';

const BRAND_A = '01937f5e-7e53-7000-8000-00000000000a';
const BRAND_B = '01937f5e-7e53-7000-8000-00000000000b';
const DEPARTMENT = '01937f5e-7e53-7000-8000-000000000011';
const TICKET = '01937f5e-7e53-7000-8000-0000000000a1';
const LINA = '01937f5e-7e53-7000-8000-000000000001';

const principal: Principal = {
  type: 'staff',
  id: LINA,
  brands: { [BRAND_A]: { role: 'agent', departmentIds: [DEPARTMENT] } },
  installAdmin: false,
};

/**
 * What the policies would answer. The gateway only has to pass it through to
 * `authorizeRoom`, whose own suite covers what it decides with it.
 */
const roomReaderAllowing = (overrides: Partial<RoomScopeReader> = {}): RoomScopeReader => ({
  ticketInScope: () => Promise.resolve(true),
  departmentInScope: () => Promise.resolve(true),
  ...overrides,
});

const roomReader = roomReaderAllowing();

interface Harness {
  readonly gateway: StaffGateway;
  readonly gauge: InMemorySocketConnectionsGauge;
  readonly presence: PresenceService;
  readonly revoked: Set<string>;
}

interface Relayed {
  readonly room: string;
  readonly event: string;
  readonly payload: unknown;
}

const socketOf = (
  id: string,
): StaffSocket & {
  rooms: Set<string>;
  disconnected: boolean;
  relayed: Relayed[];
  data: StaffSocket['data'];
} => {
  const relayed: Relayed[] = [];
  const socket = {
    id,
    rooms: new Set<string>(),
    disconnected: false,
    relayed,
    // `socket.to(room)` excludes the sender, which is what a relay is.
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        relayed.push({ room, event, payload });
      },
    }),
    data: {
      principal,
      sessionId: `sid-${id}`,
      familyId: `fam-${id}`,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      brandIds: new Set<string>(),
    },
    join: (room: string) => {
      socket.rooms.add(room);
      return Promise.resolve();
    },
    leave: (room: string) => {
      socket.rooms.delete(room);
      return Promise.resolve();
    },
    disconnect: () => {
      socket.disconnected = true;
    },
  };

  // biome-ignore lint/suspicious/noExplicitAny: the gateway uses id, data, join, leave, to and disconnect.
  return socket as any;
};

/** The close is deferred so the refusal reaches the caller first. */
const closed = async (socket: { disconnected: boolean }): Promise<boolean> => {
  await new Promise((resolve) => setTimeout(resolve, 0));

  return socket.disconnected;
};

const harness = (readerOverrides: Partial<RoomScopeReader> = {}): Harness => {
  const redis = new RedisStub();
  const publisher = new RealtimePublisher();
  const presence = new PresenceService(
    new PresenceStore(redis.asRedis()),
    publisher,
    new NoopStaffOfflineHook(),
    silentLogger(),
  );
  const gauge = new InMemorySocketConnectionsGauge();
  const revoked = new Set<string>();

  const gateway = new StaffGateway(
    { resolveSession: () => Promise.resolve(null) },
    { isSessionRevoked: (sessionId) => Promise.resolve(revoked.has(sessionId)) },
    presence,
    publisher,
    new SocketRegistry(),
    gauge,
    roomReaderAllowing(readerOverrides),
    silentLogger(),
  );

  return { gateway, gauge, presence, revoked };
};

describe('StaffGateway', () => {
  let harnessed: Harness;

  beforeEach(() => {
    harnessed = harness();
  });

  describe('room:join', () => {
    it('joins the brand room and becomes present there', async () => {
      const socket = socketOf('s1');

      const ack = await harnessed.gateway.join(socket, {
        brandId: BRAND_A,
        room: brandRoom(BRAND_A),
      });

      expect(ack).toEqual({ ok: true, data: { room: brandRoom(BRAND_A) } });
      expect(socket.rooms).toContain(brandRoom(BRAND_A));
      expect(await harnessed.presence.mapOf(BRAND_A)).toEqual({ [LINA]: 'online' });
    });

    it('refuses a brand room that is not the brand the message named', async () => {
      const socket = socketOf('s1');

      expect(
        await harnessed.gateway.join(socket, { brandId: BRAND_A, room: brandRoom(BRAND_B) }),
      ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      expect(socket.rooms.size).toBe(0);
    });

    it('refuses a department outside the scope', async () => {
      expect(
        await harnessed.gateway.join(socketOf('s1'), {
          brandId: BRAND_A,
          room: departmentRoom(BRAND_B),
        }),
      ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    });

    it('disconnects a socket whose token has expired, however long it stayed open', async () => {
      const socket = socketOf('s1');
      socket.data = { ...socket.data, expiresAt: Math.floor(Date.now() / 1000) - 1 };

      await expect(
        harnessed.gateway.join(socket, { brandId: BRAND_A, room: brandRoom(BRAND_A) }),
      ).rejects.toBeDefined();
      expect(await closed(socket)).toBe(true);
    });

    it('records presence only for brand rooms', async () => {
      const socket = socketOf('s1');

      await harnessed.gateway.join(socket, { brandId: BRAND_A, room: departmentRoom(DEPARTMENT) });

      expect(socket.data.brandIds.size).toBe(0);
      expect(await harnessed.presence.mapOf(BRAND_A)).toEqual({});
    });

    it('refuses a message that does not parse', async () => {
      await expect(
        harnessed.gateway.join(socketOf('s1'), { room: 'nonsense' }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('schema'),
      });
    });

    it('disconnects a socket whose session was revoked since the handshake', async () => {
      const socket = socketOf('s1');
      harnessed.revoked.add(socket.data.sessionId);

      await expect(
        harnessed.gateway.join(socket, { brandId: BRAND_A, room: brandRoom(BRAND_A) }),
      ).rejects.toBeDefined();
      expect(await closed(socket)).toBe(true);
    });

    it('joins a ticket room the policies allow, and records no presence for it', async () => {
      const socket = socketOf('s1');

      expect(
        await harnessed.gateway.join(socket, { brandId: BRAND_A, room: ticketRoom(TICKET) }),
      ).toEqual({ ok: true, data: { room: ticketRoom(TICKET) } });
      expect(socket.rooms.has(ticketRoom(TICKET))).toBe(true);
      expect(socket.data.brandIds.size).toBe(0);
    });

    it('refuses a ticket room the policies hide', async () => {
      const gateway = harness({ ticketInScope: () => Promise.resolve(false) }).gateway;

      expect(
        await gateway.join(socketOf('s1'), { brandId: BRAND_A, room: ticketRoom(TICKET) }),
      ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    });
  });

  describe('room:leave', () => {
    it('leaves the room and gives up presence with it', async () => {
      const socket = socketOf('s1');
      await harnessed.gateway.join(socket, { brandId: BRAND_A, room: brandRoom(BRAND_A) });

      const ack = await harnessed.gateway.leave(socket, { room: brandRoom(BRAND_A) });

      expect(ack).toEqual({ ok: true, data: { room: brandRoom(BRAND_A) } });
      expect(socket.rooms.size).toBe(0);
      expect(await harnessed.presence.mapOf(BRAND_A)).toEqual({});
    });

    it('is harmless for a room the socket never joined', async () => {
      const socket = socketOf('s1');

      expect(await harnessed.gateway.leave(socket, { room: brandRoom(BRAND_A) })).toMatchObject({
        ok: true,
      });
    });
  });

  describe('presence:set', () => {
    it('sets away and back to online for a connected socket', async () => {
      const socket = socketOf('s1');
      await harnessed.gateway.join(socket, { brandId: BRAND_A, room: brandRoom(BRAND_A) });

      expect(
        await harnessed.gateway.setPresence(socket, { brandId: BRAND_A, status: 'away' }),
      ).toEqual({ ok: true, data: { status: 'away' } });
      expect(
        await harnessed.gateway.setPresence(socket, { brandId: BRAND_A, status: 'online' }),
      ).toEqual({ ok: true, data: { status: 'online' } });
    });

    it('answers offline for a brand the socket has not joined', async () => {
      expect(
        await harnessed.gateway.setPresence(socketOf('s1'), { brandId: BRAND_A, status: 'away' }),
      ).toEqual({ ok: true, data: { status: 'offline' } });
    });
  });

  describe('presence:heartbeat', () => {
    it('keeps the socket present without announcing anything new', async () => {
      const socket = socketOf('s1');
      await harnessed.gateway.join(socket, { brandId: BRAND_A, room: brandRoom(BRAND_A) });

      const ack = await harnessed.gateway.heartbeat(socket);

      expect(ack.ok).toBe(true);
      expect(await harnessed.presence.mapOf(BRAND_A)).toEqual({ [LINA]: 'online' });
    });

    it('is harmless for a socket that has joined nothing', async () => {
      expect((await harnessed.gateway.heartbeat(socketOf('s1'))).ok).toBe(true);
    });
  });

  describe('connections', () => {
    it('keeps the socket_connections gauge honest across connect and disconnect', async () => {
      const first = socketOf('s1');
      const second = socketOf('s2');

      harnessed.gateway.handleConnection(first);
      harnessed.gateway.handleConnection(second);
      expect(harnessed.gauge.get(STAFF_NAMESPACE)).toBe(2);

      await harnessed.gateway.handleDisconnect(first);
      expect(harnessed.gauge.get(STAFF_NAMESPACE)).toBe(1);
    });

    it('gives up every brand it was present in when the socket goes', async () => {
      const socket = socketOf('s1');
      harnessed.gateway.handleConnection(socket);
      await harnessed.gateway.join(socket, { brandId: BRAND_A, room: brandRoom(BRAND_A) });

      await harnessed.gateway.handleDisconnect(socket);

      expect(await harnessed.presence.mapOf(BRAND_A)).toEqual({});
    });
  });

  describe('the handshake middleware', () => {
    const namespaceCapturing = (
      into: ((socket: unknown, next: (error?: Error) => void) => void)[],
    ): Namespace =>
      ({
        use: (middleware: (socket: unknown, next: (error?: Error) => void) => void) => {
          into.push(middleware);
        },
        // biome-ignore lint/suspicious/noExplicitAny: `afterInit` uses `use` only.
      }) as any;

    it('refuses a socket with no token before it is ever connected', async () => {
      const middlewares: ((socket: unknown, next: (error?: Error) => void) => void)[] = [];
      harnessed.gateway.afterInit(namespaceCapturing(middlewares));

      const refusal = await new Promise<Error | undefined>((resolve) => {
        middlewares[0]?.({ handshake: { auth: {} }, data: {} }, resolve);
      });

      expect(refusal).toBeInstanceOf(HandshakeRefusal);
      expect((refusal as HandshakeRefusal).data.code).toBe('unauthenticated');
    });

    it('turns an unexpected failure into a refusal rather than a hang, and logs it', async () => {
      const logger = silentLogger();
      const error = vi.spyOn(logger, 'error');
      const gateway = new StaffGateway(
        {
          resolveSession: () => Promise.reject(new Error('redis is down')),
        },
        { isSessionRevoked: () => Promise.resolve(false) },
        harnessed.presence,
        new RealtimePublisher(),
        new SocketRegistry(),
        new InMemorySocketConnectionsGauge(),
        roomReader,
        logger,
      );
      const middlewares: ((socket: unknown, next: (error?: Error) => void) => void)[] = [];
      gateway.afterInit(namespaceCapturing(middlewares));

      const refusal = await new Promise<Error | undefined>((resolve) => {
        middlewares[0]?.({ handshake: { auth: { token: 'anything' } }, data: {} }, resolve);
      });

      expect((refusal as HandshakeRefusal).data.code).toBe('internal');
      expect(error).toHaveBeenCalledOnce();
    });

    it('puts the session on the socket when the token verifies', async () => {
      const session: SocketSession = {
        principal,
        sessionId: 'sid',
        familyId: 'fam',
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      };
      const middlewares: ((socket: unknown, next: (error?: Error) => void) => void)[] = [];
      const gateway = new StaffGateway(
        { resolveSession: () => Promise.resolve(session) },
        { isSessionRevoked: () => Promise.resolve(false) },
        harnessed.presence,
        new RealtimePublisher(),
        new SocketRegistry(),
        new InMemorySocketConnectionsGauge(),
        roomReader,
        silentLogger(),
      );
      gateway.afterInit(namespaceCapturing(middlewares));

      const socket = {
        handshake: { auth: { token: 'good' } },
        data: {} as Record<string, unknown>,
      };
      await new Promise<void>((resolve) => {
        middlewares[0]?.(socket, () => resolve());
      });

      expect(socket.data).toMatchObject({ principal, sessionId: 'sid', familyId: 'fam' });
    });
  });

  describe('ticket:viewing', () => {
    it('relays the announcement to the rest of the ticket room', async () => {
      const socket = socketOf('s1');

      const ack = await harnessed.gateway.viewing(socket, { brandId: BRAND_A, ticketId: TICKET });

      expect(ack).toEqual({ ok: true, data: { ticketId: TICKET } });
      expect(socket.relayed).toEqual([
        {
          room: ticketRoom(TICKET),
          event: 'ticket:viewing',
          payload: expect.objectContaining({
            seq: null,
            data: { brandId: BRAND_A, ticketId: TICKET, userId: LINA },
          }),
        },
      ]);
    });

    it('refuses a ticket outside the caller\u2019s departments, and relays nothing', async () => {
      const refusing = harness({ ticketInScope: () => Promise.resolve(false) });
      const socket = socketOf('s1');

      const ack = await refusing.gateway.viewing(socket, { brandId: BRAND_A, ticketId: TICKET });

      expect(ack).toEqual({ ok: false, error: expect.objectContaining({ code: 'forbidden' }) });
      expect(socket.relayed).toEqual([]);
    });

    it('refuses a brand the caller holds no role in', async () => {
      const socket = socketOf('s1');

      const ack = await harnessed.gateway.viewing(socket, { brandId: BRAND_B, ticketId: TICKET });

      expect(ack).toEqual({ ok: false, error: expect.objectContaining({ code: 'forbidden' }) });
    });

    it('closes a socket whose session has been revoked rather than relaying', async () => {
      const socket = socketOf('s1');
      harnessed.revoked.add(socket.data.sessionId);

      await expect(
        harnessed.gateway.viewing(socket, { brandId: BRAND_A, ticketId: TICKET }),
      ).rejects.toThrow();
      expect(socket.relayed).toEqual([]);
      expect(await closed(socket)).toBe(true);
    });
  });
});
