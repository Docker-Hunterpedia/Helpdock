import {
  brandPresenceSchema,
  brandRoom,
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  type PresenceMap,
  presenceChangedEnvelopeSchema,
  REALTIME_EVENTS,
  roomAckSchema,
  type SettablePresenceStatus,
  SOCKET_IO_PATH,
  STAFF_NAMESPACE,
  socketErrorSchema,
} from '@helpdock/schemas';
import { io } from 'socket.io-client';
import { backoffDelay } from './backoff.js';
import { type RealtimeClient, type RealtimeListener, RealtimeListeners } from './client.js';

/**
 * The real connection to the `/staff` namespace.
 *
 * Three things it does that a bare `io()` would not:
 *
 * 1. **Reconnects itself.** Socket.IO's own reconnection is off, because every
 *    attempt has to carry a *fresh* access token — the one this tab held ten
 *    minutes ago has expired, and re-presenting it would fail the handshake
 *    forever. Each attempt asks the auth adapter for a current one.
 * 2. **Heartbeats.** Every 25 s against the server's 60 s liveness TTL, so two
 *    may be lost before anyone is called offline (DOMAIN-RULES §12).
 * 3. **Stops when told the session is gone.** A `revoked` frame is not a
 *    network failure, so reconnecting after one would be a loop against a
 *    server that will refuse every attempt.
 */

/** The subset of a Socket.IO socket this client uses; a test supplies its own. */
export interface RealtimeSocket {
  on(event: string, handler: (payload: unknown) => void): unknown;
  emit(event: string, payload: unknown): unknown;
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
  disconnect(): unknown;
}

export type SocketFactory = (token: string) => RealtimeSocket;

export interface SocketRealtimeClientOptions {
  /** A current access token, refreshed if need be, or `null` when signed out. */
  token(): Promise<string | null>;
  /** Same origin as the api in every deployment shape (ARCHITECTURE §3). */
  readonly baseUrl?: string;
  readonly connect?: SocketFactory;
  readonly fetch?: typeof globalThis.fetch;
}

const defaultConnect =
  (baseUrl: string): SocketFactory =>
  (token) =>
    io(`${baseUrl}${STAFF_NAMESPACE}`, {
      path: SOCKET_IO_PATH,
      // The server offers nothing else (ARCHITECTURE §12).
      transports: ['websocket'],
      auth: { token },
      // Ours, so that every attempt carries a fresh token.
      reconnection: false,
      withCredentials: true,
    }) as unknown as RealtimeSocket;

/**
 * Whether a handshake refusal is worth retrying. `forbidden` is the one answer
 * a fresh token cannot change — this principal does not belong on this
 * namespace — so retrying it is a loop.
 */
const isTerminal = (error: unknown): boolean => {
  const parsed = socketErrorSchema.safeParse((error as { data?: unknown })?.data);

  return parsed.success && parsed.data.code === 'forbidden';
};

export class SocketRealtimeClient implements RealtimeClient {
  readonly #listeners = new RealtimeListeners();
  readonly #token: () => Promise<string | null>;
  readonly #connect: SocketFactory;
  readonly #fetch: typeof globalThis.fetch;
  readonly #apiUrl: string;

  #socket: RealtimeSocket | null = null;
  #brandId: string | null = null;
  #attempt = 0;
  #reconnect: ReturnType<typeof setTimeout> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  /** A generation counter, so a socket opened by a superseded `start` is ignored. */
  #epoch = 0;

  constructor(options: SocketRealtimeClientOptions) {
    const baseUrl = options.baseUrl ?? '';
    this.#token = options.token;
    this.#connect = options.connect ?? defaultConnect(baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#apiUrl = `${baseUrl}/api`;
  }

  subscribe(listener: RealtimeListener): () => void {
    return this.#listeners.add(listener);
  }

  start(brandId: string): void {
    if (this.#brandId === brandId && this.#socket !== null) {
      return;
    }

    this.#close();
    this.#brandId = brandId;
    this.#attempt = 0;
    void this.#open(this.#epoch);
  }

  stop(): void {
    this.#brandId = null;
    this.#close();
    this.#listeners.connection('closed');
  }

  async presence(brandId: string): Promise<PresenceMap> {
    const token = await this.#token();
    if (token === null) {
      return {};
    }

    const response = await this.#fetch(`${this.#apiUrl}/brands/${brandId}/presence`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      // A screen that cannot read the map renders an empty one and fills in
      // from events; it must never fail to render because of a notification.
      return {};
    }

    const parsed = brandPresenceSchema.safeParse(await response.json());

    return parsed.success ? parsed.data.presence : {};
  }

  async setPresence(status: SettablePresenceStatus): Promise<void> {
    const brandId = this.#brandId;
    if (this.#socket === null || brandId === null) {
      return;
    }

    await this.#socket.emitWithAck(REALTIME_EVENTS.presenceSet, { brandId, status });
  }

  // ------------------------------------------------------------------

  async #open(epoch: number): Promise<void> {
    const brandId = this.#brandId;
    if (brandId === null) {
      return;
    }

    this.#listeners.connection('connecting');

    const token = await this.#token();
    if (epoch !== this.#epoch) {
      return;
    }
    if (token === null) {
      // Signed out, or the refresh failed. Another attempt costs nothing and
      // the next one may find a session again.
      this.#scheduleReconnect();
      return;
    }

    const socket = this.#connect(token);
    this.#socket = socket;

    socket.on('connect', () => {
      if (epoch !== this.#epoch) {
        return;
      }
      this.#attempt = 0;
      this.#startHeartbeat(socket);
      void this.#join(socket, brandId, epoch);
    });

    socket.on(REALTIME_EVENTS.presenceChanged, (envelope) => {
      const parsed = presenceChangedEnvelopeSchema.safeParse(envelope);
      if (parsed.success) {
        this.#listeners.presenceChanged(parsed.data.data);
      }
    });

    // The session ended somewhere else (DOMAIN-RULES §1.4). Reconnecting would
    // be a loop against a server that will refuse every attempt.
    socket.on('revoked', () => {
      this.stop();
    });

    socket.on('disconnect', () => {
      if (epoch === this.#epoch) {
        this.#scheduleReconnect();
      }
    });
    socket.on('connect_error', (error) => {
      if (epoch !== this.#epoch) {
        return;
      }
      if (isTerminal(error)) {
        this.stop();
        return;
      }
      this.#scheduleReconnect();
    });
  }

  /**
   * A connected socket that was refused its room is not connected in any sense
   * a screen cares about: it would sit there with a presence feed that never
   * updates. Retrying is right — a refusal here is usually a revoked session,
   * and the next attempt fetches a fresh token and learns so at the handshake.
   */
  async #join(socket: RealtimeSocket, brandId: string, epoch: number): Promise<void> {
    const ack = roomAckSchema.safeParse(
      await socket.emitWithAck(REALTIME_EVENTS.roomJoin, { brandId, room: brandRoom(brandId) }),
    );
    if (epoch !== this.#epoch) {
      return;
    }

    if (ack.success && ack.data.ok) {
      this.#listeners.connection('connected');
      return;
    }

    this.#scheduleReconnect();
  }

  #startHeartbeat(socket: RealtimeSocket): void {
    clearInterval(this.#heartbeat);
    this.#heartbeat = setInterval(() => {
      socket.emit(REALTIME_EVENTS.presenceHeartbeat, {});
    }, PRESENCE_HEARTBEAT_INTERVAL_MS);
  }

  #scheduleReconnect(): void {
    if (this.#brandId === null) {
      return;
    }

    clearInterval(this.#heartbeat);
    this.#socket?.disconnect();
    this.#socket = null;
    this.#listeners.connection('connecting');

    // A new generation, so the socket that just failed can raise no more events.
    this.#epoch += 1;
    const epoch = this.#epoch;
    const delay = backoffDelay(this.#attempt);
    this.#attempt += 1;

    clearTimeout(this.#reconnect);
    this.#reconnect = setTimeout(() => {
      void this.#open(epoch);
    }, delay);
  }

  #close(): void {
    this.#epoch += 1;
    clearTimeout(this.#reconnect);
    clearInterval(this.#heartbeat);
    this.#socket?.disconnect();
    this.#socket = null;
  }
}
