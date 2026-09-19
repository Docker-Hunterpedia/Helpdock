import {
  brandRoom,
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  type PresenceChanged,
  REALTIME_EVENTS,
} from '@helpdock/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECONNECT_MAX_MS } from './backoff.js';
import type { RealtimeConnection } from './client.js';
import type { RealtimeSocket } from './socket-client.js';
import { SocketRealtimeClient } from './socket-client.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const OTHER_BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000002';
const LINA = '0192c3f0-1a2b-7c3d-8e4f-00000000000a';

/** A socket whose events a test fires by hand. */
class FakeSocket implements RealtimeSocket {
  readonly emitted: { event: string; payload: unknown }[] = [];
  readonly acked: { event: string; payload: unknown }[] = [];
  disconnected = false;
  readonly #handlers = new Map<string, (payload: never) => void>();

  constructor(readonly token: string) {}

  on(event: string, handler: (payload: never) => void): unknown {
    this.#handlers.set(event, handler);
    return this;
  }

  emit(event: string, payload: unknown): unknown {
    this.emitted.push({ event, payload });
    return this;
  }

  /** What the next acknowledgement answers. A refusal is a test's to choose. */
  ack: unknown = { ok: true, data: { room: 'brand:0192c3f0-1a2b-7c3d-8e4f-000000000001' } };

  emitWithAck(event: string, payload: unknown): Promise<unknown> {
    this.acked.push({ event, payload });
    return Promise.resolve(this.ack);
  }

  disconnect(): unknown {
    this.disconnected = true;
    return this;
  }

  fire(event: string, payload?: unknown): void {
    this.#handlers.get(event)?.(payload as never);
  }
}

describe('SocketRealtimeClient', () => {
  let sockets: FakeSocket[];
  let states: RealtimeConnection[];
  let changes: PresenceChanged[];
  let token: string | null;

  const clientWith = (fetchImpl?: typeof globalThis.fetch) => {
    const client = new SocketRealtimeClient({
      token: () => Promise.resolve(token),
      connect: (given) => {
        const socket = new FakeSocket(given);
        sockets.push(socket);
        return socket;
      },
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    });
    client.subscribe({
      connection: (state) => states.push(state),
      presenceChanged: (change) => changes.push(change),
    });

    return client;
  };

  /**
   * `start` awaits the token before it opens and the join is acknowledged
   * asynchronously, so a test has to let both settle.
   */
  const settle = async () => {
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    states = [];
    changes = [];
    token = 'token-1';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens with the current token and joins the brand room', async () => {
    const client = clientWith();
    client.start(BRAND);
    await settle();

    expect(sockets[0]?.token).toBe('token-1');
    sockets[0]?.fire('connect');
    await settle();

    expect(sockets[0]?.acked).toEqual([
      { event: REALTIME_EVENTS.roomJoin, payload: { brandId: BRAND, room: brandRoom(BRAND) } },
    ]);
    expect(states).toEqual(['connecting', 'connected']);
  });

  it('does not report itself connected when the room join is refused', async () => {
    const client = clientWith();
    client.start(BRAND);
    await settle();
    const socket = sockets[0];
    if (socket !== undefined) {
      socket.ack = { ok: false, error: { code: 'forbidden', message: 'no' } };
    }

    socket?.fire('connect');
    await settle();

    // A socket in a room it was refused has a presence feed that never
    // updates; reporting it as connected would be a lie a screen acts on.
    expect(states).not.toContain('connected');
  });

  it('stops for good on a handshake refusal a fresh token cannot fix', async () => {
    const client = clientWith();
    client.start(BRAND);
    await settle();

    sockets[0]?.fire('connect_error', { data: { code: 'forbidden', message: 'not staff' } });
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 2);

    expect(sockets).toHaveLength(1);
    expect(states.at(-1)).toBe('closed');
  });

  it('heartbeats every 25 seconds while it is connected', async () => {
    const client = clientWith();
    client.start(BRAND);
    await settle();
    sockets[0]?.fire('connect');
    await settle();

    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_INTERVAL_MS * 2);

    expect(
      sockets[0]?.emitted.filter((e) => e.event === REALTIME_EVENTS.presenceHeartbeat),
    ).toHaveLength(2);
  });

  it('reconnects with a fresh token, because the one it held has expired', async () => {
    const client = clientWith();
    client.start(BRAND);
    await settle();
    sockets[0]?.fire('connect');
    await settle();

    token = 'token-2';
    sockets[0]?.fire('disconnect');
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS);

    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.token).toBe('token-2');
  });

  it('keeps trying when the refresh comes back empty', async () => {
    token = null;
    const client = clientWith();
    client.start(BRAND);
    await settle();

    expect(sockets).toHaveLength(0);

    token = 'token-2';
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS);

    expect(sockets[0]?.token).toBe('token-2');
  });

  it('backs off: two failures do not produce two immediate attempts', async () => {
    // Full jitter can legitimately answer 0 ms; pinning it to the ceiling is
    // what makes "did not reconnect yet" a statement about the backoff.
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const client = clientWith();
    client.start(BRAND);
    await settle();
    sockets[0]?.fire('connect_error');

    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS);
    expect(sockets).toHaveLength(2);
  });

  it('treats a disconnect and a connect error from one socket as one failure', async () => {
    const client = clientWith();
    client.start(BRAND);
    await settle();
    sockets[0]?.fire('connect_error');
    sockets[0]?.fire('disconnect');

    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 2);

    expect(sockets).toHaveLength(2);
  });

  it('stops for good when the server says the session was revoked', async () => {
    const client = clientWith();
    client.start(BRAND);
    await settle();
    sockets[0]?.fire('connect');

    await settle();
    sockets[0]?.fire('revoked');
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 2);

    expect(sockets).toHaveLength(1);
    expect(states.at(-1)).toBe('closed');
  });

  it('parses what arrives and ignores a frame that does not match the contract', async () => {
    const client = clientWith();
    client.start(BRAND);
    await settle();
    const socket = sockets[0];

    socket?.fire(REALTIME_EVENTS.presenceChanged, {
      seq: null,
      at: new Date().toISOString(),
      data: { userId: LINA, brandId: BRAND, status: 'away' },
    });
    socket?.fire(REALTIME_EVENTS.presenceChanged, { data: { userId: LINA, status: 'sleeping' } });

    expect(changes).toEqual([{ userId: LINA, brandId: BRAND, status: 'away' }]);
  });

  it('re-targets the same client when the brand changes', async () => {
    const client = clientWith();
    client.start(BRAND);
    await settle();
    sockets[0]?.fire('connect');

    client.start(OTHER_BRAND);
    await settle();
    sockets[1]?.fire('connect');
    await settle();

    expect(sockets[0]?.disconnected).toBe(true);
    expect(sockets[1]?.acked[0]?.payload).toEqual({
      brandId: OTHER_BRAND,
      room: brandRoom(OTHER_BRAND),
    });
  });

  it('does nothing when told to start the brand it is already on', async () => {
    const client = clientWith();
    client.start(BRAND);
    await settle();
    client.start(BRAND);
    await settle();

    expect(sockets).toHaveLength(1);
  });

  it('sends the toggle over the socket', async () => {
    const client = clientWith();
    client.start(BRAND);
    await settle();
    sockets[0]?.fire('connect');
    await settle();

    await client.setPresence('away');

    expect(sockets[0]?.acked.at(-1)).toEqual({
      event: REALTIME_EVENTS.presenceSet,
      payload: { brandId: BRAND, status: 'away' },
    });
  });

  it('drops a toggle made while there is no socket rather than throwing at the caller', async () => {
    const client = clientWith();

    await expect(client.setPresence('away')).resolves.toBeUndefined();
  });

  it('closes on stop and does not come back', async () => {
    const client = clientWith();
    client.start(BRAND);
    await settle();
    sockets[0]?.fire('connect');
    await settle();

    client.stop();
    sockets[0]?.fire('disconnect');
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 2);

    expect(sockets).toHaveLength(1);
    expect(states.at(-1)).toBe('closed');
  });

  it('opens nothing when it is stopped before the token arrives', async () => {
    const client = clientWith();
    client.start(BRAND);
    client.stop();
    await settle();

    expect(sockets).toHaveLength(0);
  });

  it('ignores a socket that connects after the client has moved on', async () => {
    const client = clientWith();
    client.start(BRAND);
    await settle();
    const stale = sockets[0];

    client.start(OTHER_BRAND);
    await settle();
    stale?.fire('connect');

    expect(stale?.acked).toEqual([]);
  });

  describe('the presence snapshot', () => {
    const okResponse = (body: unknown) =>
      vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response),
      ) as unknown as typeof globalThis.fetch;

    it('reads the REST map, which is the truth a screen renders first', async () => {
      const fetchImpl = okResponse({
        brandId: BRAND,
        presence: { [LINA]: 'online' },
        at: new Date().toISOString(),
      });

      expect(await clientWith(fetchImpl).presence(BRAND)).toEqual({ [LINA]: 'online' });
      expect(fetchImpl).toHaveBeenCalledWith(
        `/api/brands/${BRAND}/presence`,
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: 'Bearer token-1' }),
        }),
      );
    });

    it.each([
      ['there is no session', null, okResponse({})],
      [
        'the request fails',
        'token-1',
        vi.fn(() =>
          Promise.resolve({ ok: false } as Response),
        ) as unknown as typeof globalThis.fetch,
      ],
      [
        'the body is not a presence map',
        'token-1',
        okResponse({ brandId: BRAND, presence: { [LINA]: 'busy' }, at: new Date().toISOString() }),
      ],
    ])('answers with an empty map when %s', async (_name, given, fetchImpl) => {
      token = given;

      expect(await clientWith(fetchImpl).presence(BRAND)).toEqual({});
    });
  });
});
