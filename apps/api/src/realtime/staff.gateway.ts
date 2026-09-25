import {
  type HeartbeatAck,
  type PresenceAck,
  parseRoom,
  presenceSetSchema,
  REALTIME_EVENTS,
  type RoomAck,
  roomJoinSchema,
  roomLeaveSchema,
  STAFF_NAMESPACE,
  type TicketViewingAck,
  ticketRoom,
  ticketViewingRequestSchema,
} from '@helpdock/schemas';
import { Inject, UseFilters } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Namespace } from 'socket.io';
import { Authenticated, Requires } from '../auth/route-declaration.js';
import type { Logger } from '../logging/logger.js';
import { LOGGER } from '../runtime/tokens.js';
import { AckExceptionFilter } from './ack-exception.filter.js';
import { authenticateHandshake, type SocketSessionResolver } from './handshake.js';
import { parseMessage, socketRefusal } from './messages.js';
import type { SocketConnectionsGauge } from './metrics.js';
import { PresenceService } from './presence.service.js';
import { RealtimePublisher } from './publisher.js';
import type { RoomScopeReader } from './room-reader.js';
import { authorizeRoom } from './rooms.js';
import { HandshakeRefusal, type StaffSocket, userIdOf } from './socket.js';
import { SocketRegistry } from './socket-registry.js';
import {
  ROOM_SCOPE_READER,
  SESSION_REVOCATIONS,
  SOCKET_CONNECTIONS_GAUGE,
  SOCKET_SESSION_RESOLVER,
} from './tokens.js';

/**
 * The staff side of the realtime gateway (ARCHITECTURE §8, DOMAIN-RULES §1.4
 * and §7). One namespace, three things it does:
 *
 * 1. **Handshake.** `auth.token` is the access token, verified by the same
 *    session resolver the HTTP guards use. No principal, no connection —
 *    refused with a code, never left hanging.
 * 2. **Rooms.** `brand:`, `department:` and `ticket:`. The permission is
 *    checked by the global `PermissionGuard` from the `@Requires` below, the
 *    department scope by `authorizeRoom` — which asks the same policies a REST
 *    read would — and the session's revocation is re-asked on every join so a
 *    socket opened ten minutes ago cannot outlive its session by joining
 *    something new.
 * 3. **Presence.** Derived from the `brand:` rooms this namespace holds, across
 *    every replica.
 *
 * Only `/staff` lives here. The `/widget` namespace is M4-04 and gets its own
 * gateway, its own visitor credential and its own rooms.
 */

/** The narrow half of `RefreshStore` a join needs. */
export interface SessionRevocations {
  isSessionRevoked(sessionId: string): Promise<boolean>;
}

const ok = <T>(data: T) => ({ ok: true, data }) as const;

/** `exp` is in seconds; `Date.now()` is not. */
const MILLISECONDS = 1000;

@WebSocketGateway({ namespace: STAFF_NAMESPACE })
@UseFilters(AckExceptionFilter)
export class StaffGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  readonly #resolver: SocketSessionResolver;
  readonly #revocations: SessionRevocations;
  readonly #presence: PresenceService;
  readonly #publisher: RealtimePublisher;
  readonly #registry: SocketRegistry;
  readonly #gauge: SocketConnectionsGauge;
  readonly #rooms: RoomScopeReader;
  readonly #logger: Logger;

  constructor(
    @Inject(SOCKET_SESSION_RESOLVER) resolver: SocketSessionResolver,
    @Inject(SESSION_REVOCATIONS) revocations: SessionRevocations,
    @Inject(PresenceService) presence: PresenceService,
    @Inject(RealtimePublisher) publisher: RealtimePublisher,
    @Inject(SocketRegistry) registry: SocketRegistry,
    @Inject(SOCKET_CONNECTIONS_GAUGE) gauge: SocketConnectionsGauge,
    @Inject(ROOM_SCOPE_READER) rooms: RoomScopeReader,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.#resolver = resolver;
    this.#revocations = revocations;
    this.#presence = presence;
    this.#publisher = publisher;
    this.#registry = registry;
    this.#gauge = gauge;
    this.#rooms = rooms;
    this.#logger = logger;
  }

  afterInit(namespace: Namespace): void {
    this.#publisher.bind(namespace);

    // Middleware rather than `handleConnection`, because a connection that is
    // going to be refused must never exist: by the time `handleConnection` runs
    // the client is connected and can emit, and it would have to be
    // disconnected after the fact.
    namespace.use((socket, next) => {
      void authenticateHandshake({ auth: socket.handshake.auth, resolver: this.#resolver }).then(
        (data) => {
          Object.assign(socket.data, data);
          next();
        },
        (error: unknown) => {
          if (!(error instanceof HandshakeRefusal)) {
            this.#logger.error({ err: error }, 'A staff handshake could not be checked');
          }

          next(
            error instanceof HandshakeRefusal
              ? error
              : new HandshakeRefusal('internal', 'The handshake could not be checked'),
          );
        },
      );
    });
  }

  handleConnection(socket: StaffSocket): void {
    this.#registry.add(socket);
    this.#gauge.set({ namespace: STAFF_NAMESPACE }, this.#registry.size());
    this.#logger.debug(
      { userId: userIdOf(socket.data), familyId: socket.data.familyId },
      'staff socket connected',
    );
  }

  /**
   * Nest binds this with `client.on('disconnect', …)` and neither awaits nor
   * catches it, so a rejection here would be an unhandled one. Redis being
   * briefly unreachable must not take the process down, and it does not have
   * to: the liveness key expires within a minute and the reaper finishes the
   * job this call could not.
   */
  async handleDisconnect(socket: StaffSocket): Promise<void> {
    this.#registry.remove(socket);
    this.#gauge.set({ namespace: STAFF_NAMESPACE }, this.#registry.size());

    const userId = userIdOf(socket.data);
    try {
      for (const brandId of socket.data.brandIds) {
        await this.#presence.leave({ brandId, userId, socketId: socket.id });
      }
    } catch (error) {
      this.#logger.error(
        { err: error, userId },
        'Could not give up presence on disconnect; the reaper will',
      );
    }
  }

  @SubscribeMessage(REALTIME_EVENTS.roomJoin)
  @Requires('brand:read')
  async join(
    @ConnectedSocket() socket: StaffSocket,
    @MessageBody() body: unknown,
  ): Promise<RoomAck> {
    const { brandId, room } = parseMessage(roomJoinSchema, body);
    await this.#requireLiveSession(socket);

    const authorization = await authorizeRoom({
      principal: socket.data.principal,
      brandId,
      room,
      reader: this.#rooms,
    });
    if (!authorization.ok) {
      return { ok: false, error: authorization.error };
    }

    await socket.join(room);

    if (parseRoom(room)?.kind === 'brand') {
      socket.data.brandIds.add(brandId);
      await this.#presence.join({ brandId, userId: userIdOf(socket.data), socketId: socket.id });
    }

    return ok({ room });
  }

  @SubscribeMessage(REALTIME_EVENTS.roomLeave)
  @Authenticated()
  async leave(
    @ConnectedSocket() socket: StaffSocket,
    @MessageBody() body: unknown,
  ): Promise<RoomAck> {
    const { room } = parseMessage(roomLeaveSchema, body);
    await socket.leave(room);

    const parsed = parseRoom(room);
    if (parsed?.kind === 'brand' && socket.data.brandIds.delete(parsed.id)) {
      await this.#presence.leave({
        brandId: parsed.id,
        userId: userIdOf(socket.data),
        socketId: socket.id,
      });
    }

    return ok({ room });
  }

  @SubscribeMessage(REALTIME_EVENTS.presenceSet)
  @Requires('brand:read')
  async setPresence(
    @ConnectedSocket() socket: StaffSocket,
    @MessageBody() body: unknown,
  ): Promise<PresenceAck> {
    const { brandId, status } = parseMessage(presenceSetSchema, body);
    await this.#requireLiveSession(socket);

    return ok({
      status: await this.#presence.setStatus({ brandId, userId: userIdOf(socket.data) }, status),
    });
  }

  /**
   * The client refreshes its liveness key every 25 s against a 60 s TTL, so two
   * heartbeats may be lost before anyone is called offline (DOMAIN-RULES §12).
   * It names no brand: one socket's liveness covers every brand room it holds.
   */
  @SubscribeMessage(REALTIME_EVENTS.presenceHeartbeat)
  @Authenticated()
  async heartbeat(@ConnectedSocket() socket: StaffSocket): Promise<HeartbeatAck> {
    await this.#requireLiveSession(socket);

    const userId = userIdOf(socket.data);
    await this.#presence.heartbeat(
      socket.id,
      [...socket.data.brandIds].map((brandId) => ({ brandId, userId, socketId: socket.id })),
    );

    return ok({ at: new Date().toISOString() });
  }

  /**
   * "Somebody else has this ticket open", which is the collision indicator of
   * DESIGN §6.5 and all M1-15 needs of DOMAIN-RULES §2.4 (M1-09 owns the rest).
   *
   * A room is not a membership list. `socketsJoin` can tell this replica who is
   * in `ticket:<id>` *here*, and the answer has to be true across every
   * replica, so the clients say so instead and the server relays it. The
   * announcement is authorised exactly as the join was — the sender may already
   * be in the room, and a socket that left the room is not entitled to put a
   * name into it — and it is relayed to the rest of the room rather than
   * echoed, because a client knows it is looking at the ticket itself.
   *
   * Nothing is stored. A name nobody repeats inside `TICKET_VIEWING_TTL_MS` is
   * dropped by each client, which is what makes "closed the tab" and "lost the
   * network" the same thing here.
   */
  @SubscribeMessage(REALTIME_EVENTS.ticketViewing)
  @Requires('ticket:read')
  async viewing(
    @ConnectedSocket() socket: StaffSocket,
    @MessageBody() body: unknown,
  ): Promise<TicketViewingAck> {
    const { brandId, ticketId } = parseMessage(ticketViewingRequestSchema, body);
    await this.#requireLiveSession(socket);

    const room = ticketRoom(ticketId);
    const authorization = await authorizeRoom({
      principal: socket.data.principal,
      brandId,
      room,
      reader: this.#rooms,
    });
    if (!authorization.ok) {
      return { ok: false, error: authorization.error };
    }

    socket.to(room).emit(
      REALTIME_EVENTS.ticketViewing,
      this.#publisher.envelope(REALTIME_EVENTS.ticketViewing, {
        brandId,
        ticketId,
        userId: userIdOf(socket.data),
      }),
    );

    return ok({ ticketId });
  }

  /**
   * Two questions, asked before anything a socket does, because a socket
   * outlives the token it was opened with.
   *
   * 1. **Has the token expired?** A socket's authority is its access token, and
   *    DOMAIN-RULES §1.6 caps that at ten minutes. Without this, a connection
   *    opened once would carry its claims for as long as it stayed open.
   * 2. **Has the session been revoked?** "Every replica disconnects that
   *    principal's sockets within 5 seconds" (§1.4) is the revocation
   *    subscriber's push; this is the pull, for the window before that message
   *    arrives and for a replica that missed it. The marker itself lives only
   *    as long as an access token can, which is why check 1 has to come first.
   */
  async #requireLiveSession(socket: StaffSocket): Promise<void> {
    if (Date.now() >= socket.data.expiresAt * MILLISECONDS) {
      throw this.#closing(
        socket,
        socketRefusal('unauthenticated', 'The token this socket was opened with has expired'),
      );
    }

    if (await this.#revocations.isSessionRevoked(socket.data.sessionId)) {
      throw this.#closing(
        socket,
        socketRefusal('session_revoked', 'That session has been revoked'),
      );
    }
  }

  /**
   * The refusal has to reach the caller before the socket closes, or the
   * acknowledgement it is awaiting never arrives and the client sees a bare
   * disconnect instead of a reason. The close is deferred by one turn of the
   * event loop, which is after the filter has written the ack.
   */
  #closing(socket: StaffSocket, refusal: Error): Error {
    setTimeout(() => socket.disconnect(true), 0).unref();

    return refusal;
  }
}
