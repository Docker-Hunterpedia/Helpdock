import {
  VISITOR_AUTH_SCHEME,
  WIDGET_EVENTS,
  WIDGET_NAMESPACE,
  type WidgetAck,
  type WidgetErrorCode,
  type WidgetJoinAck,
  type WidgetSendAck,
  widgetHandshakeSchema,
  widgetJoinSchema,
  widgetReadSchema,
  widgetSocketSendSchema,
  widgetTypingSetSchema,
} from '@helpdock/schemas';
import { Inject } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import type { z } from 'zod';
import { Public } from '../auth/route-declaration.js';
import type { Logger } from '../logging/logger.js';
import { LOGGER } from '../runtime/tokens.js';
import { WidgetActivityService } from './widget-activity.service.js';
import { WidgetConfigService } from './widget-config.service.js';
import { WidgetConversationsService } from './widget-conversations.service.js';
import { WidgetFailure } from './widget-failure.js';
import { WidgetGate, type WidgetRequestFacts } from './widget-gate.js';
import { WidgetHub } from './widget-hub.js';
import { brandVisitorsRoom, conversationRoom, widgetEnvelope } from './widget-relay.js';

/** What the handshake proved, kept on the socket for its lifetime. */
export interface WidgetSocketData {
  readonly brandId: string;
  readonly visitorId: string;
  /** Held server-side only, so each event is re-judged exactly as a REST call is. */
  readonly secret: string;
  readonly origin: string | undefined;
  readonly ip: string | null;
}

export type WidgetSocket = Socket<
  Record<string, never>,
  Record<string, (...args: unknown[]) => void>,
  Record<string, never>,
  WidgetSocketData
>;

/** A handshake refusal, as Socket.IO hands it to the client's `connect_error`. */
export class WidgetHandshakeRefusal extends Error {
  readonly data: { readonly code: WidgetErrorCode };

  constructor(code: WidgetErrorCode, message: string) {
    super(message);
    this.name = 'WidgetHandshakeRefusal';
    this.data = { code };
  }
}

const factsOf = (data: WidgetSocketData): WidgetRequestFacts => ({
  origin: data.origin,
  authorization: `${VISITOR_AUTH_SCHEME} ${data.secret}`,
  ip: data.ip,
  viaSocket: true,
});

/**
 * The `/widget` namespace on M0-13's gateway (M4-03, M4-04; DOMAIN-RULES §7).
 *
 * - **Handshake**: `auth: { brandId, visitorSecret }`, the page's `Origin`
 *   against the brand's allow-list, and the address throttle — the same gate
 *   every REST route passes. No visitor, no connection.
 * - **Rooms**: `conversation:<id>`, joined only through `conversation:join`,
 *   which runs the same ownership check as `GET …/conversations/:id`; and
 *   `visitors:<brandId>`, joined on connect, for presence.
 * - **Events**: sending over the socket is the REST send with an
 *   acknowledgement — same `clientId` dedupe, same `seq` — and typing and read
 *   receipts go to the agents. Every event is re-judged through the gate, so
 *   a visitor whose brand removed the page's origin is refused on the next
 *   event rather than at the next reconnect.
 *
 * Every handler answers an acknowledgement and never throws: a refusal is
 * `{ ok: false, error: { code } }` with the widget's own error codes.
 */
@WebSocketGateway({ namespace: WIDGET_NAMESPACE })
export class WidgetGateway implements OnGatewayInit, OnGatewayConnection {
  readonly #gate: WidgetGate;
  readonly #hub: WidgetHub;
  readonly #conversations: WidgetConversationsService;
  readonly #activity: WidgetActivityService;
  readonly #config: WidgetConfigService;
  readonly #logger: Logger;

  constructor(
    @Inject(WidgetGate) gate: WidgetGate,
    @Inject(WidgetHub) hub: WidgetHub,
    @Inject(WidgetConversationsService) conversations: WidgetConversationsService,
    @Inject(WidgetActivityService) activity: WidgetActivityService,
    @Inject(WidgetConfigService) config: WidgetConfigService,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.#gate = gate;
    this.#hub = hub;
    this.#conversations = conversations;
    this.#activity = activity;
    this.#config = config;
    this.#logger = logger;
  }

  afterInit(namespace: Namespace): void {
    this.#hub.bind(namespace);
    namespace.use((socket, next) => {
      void this.#handshake(socket).then(
        (data) => {
          Object.assign(socket.data, data);
          next();
        },
        (error: unknown) => next(this.#refusal(error)),
      );
    });
  }

  async handleConnection(socket: WidgetSocket): Promise<void> {
    await socket.join(brandVisitorsRoom(socket.data.brandId));
    try {
      socket.emit(
        WIDGET_EVENTS.presence,
        widgetEnvelope(
          WIDGET_EVENTS.presence,
          await this.#config.presence(socket.data.brandId),
          null,
        ),
      );
    } catch (error) {
      // Presence is a nicety; a Redis hiccup must not cost the connection.
      this.#logger.warn({ err: error }, 'Could not tell a widget socket who is online');
    }
  }

  @SubscribeMessage(WIDGET_EVENTS.join)
  @Public()
  join(
    @ConnectedSocket() socket: WidgetSocket,
    @MessageBody() body: unknown,
  ): Promise<WidgetJoinAck> {
    return this.#ack(socket, widgetJoinSchema, body, async ({ conversationId }) => {
      const joined = await this.#gate.visitor(
        socket.data.brandId,
        factsOf(socket.data),
        { write: false },
        async (scope) => {
          const entry = await this.#conversations.require(scope, conversationId);
          return {
            entry,
            lastSeq: await this.#conversations.lastSeqOf(scope, entry.ticket.id),
            queue: await this.#conversations.queueOf(scope, entry),
          };
        },
      );
      await socket.join(conversationRoom(joined.entry.ticket.id));
      socket.emit(WIDGET_EVENTS.queue, widgetEnvelope(WIDGET_EVENTS.queue, joined.queue, null));

      return { conversationId: joined.entry.ticket.id, lastSeq: joined.lastSeq };
    });
  }

  @SubscribeMessage(WIDGET_EVENTS.leave)
  @Public()
  leave(
    @ConnectedSocket() socket: WidgetSocket,
    @MessageBody() body: unknown,
  ): Promise<WidgetAck<{ conversationId: string }>> {
    return this.#ack(socket, widgetJoinSchema, body, async ({ conversationId }) => {
      await socket.leave(conversationRoom(conversationId));
      return { conversationId };
    });
  }

  @SubscribeMessage(WIDGET_EVENTS.send)
  @Public()
  send(
    @ConnectedSocket() socket: WidgetSocket,
    @MessageBody() body: unknown,
  ): Promise<WidgetSendAck> {
    return this.#ack(socket, widgetSocketSendSchema, body, ({ conversationId, message }) =>
      this.#conversations.send(socket.data.brandId, factsOf(socket.data), conversationId, message),
    );
  }

  @SubscribeMessage(WIDGET_EVENTS.typingSet)
  @Public()
  typing(
    @ConnectedSocket() socket: WidgetSocket,
    @MessageBody() body: unknown,
  ): Promise<WidgetAck<{ conversationId: string }>> {
    return this.#ack(socket, widgetTypingSetSchema, body, async ({ conversationId, typing }) => {
      await this.#activity.typing(
        socket.data.brandId,
        factsOf(socket.data),
        conversationId,
        typing,
      );
      return { conversationId };
    });
  }

  @SubscribeMessage(WIDGET_EVENTS.read)
  @Public()
  read(
    @ConnectedSocket() socket: WidgetSocket,
    @MessageBody() body: unknown,
  ): Promise<WidgetAck<{ conversationId: string }>> {
    return this.#ack(socket, widgetReadSchema, body, async ({ conversationId, seq }) => {
      await this.#activity.read(socket.data.brandId, factsOf(socket.data), conversationId, seq);
      return { conversationId };
    });
  }

  async #handshake(socket: Socket): Promise<WidgetSocketData> {
    const auth = widgetHandshakeSchema.safeParse(socket.handshake.auth);
    if (!auth.success) {
      throw new WidgetFailure(
        'unauthenticated',
        'The handshake needs auth.brandId and auth.visitorSecret',
      );
    }
    const origin = socket.handshake.headers.origin;
    const ip = socket.handshake.address === '' ? null : socket.handshake.address;
    const { visitorId } = await this.#gate.handshake(
      auth.data.brandId,
      { origin, ip },
      auth.data.visitorSecret,
    );

    return { brandId: auth.data.brandId, visitorId, secret: auth.data.visitorSecret, origin, ip };
  }

  #refusal(error: unknown): WidgetHandshakeRefusal {
    if (error instanceof WidgetFailure) {
      return new WidgetHandshakeRefusal(error.reason, error.message);
    }
    this.#logger.error({ err: error }, 'A widget handshake could not be checked');
    return new WidgetHandshakeRefusal('internal', 'The handshake could not be checked');
  }

  async #ack<S extends z.ZodType, T>(
    _socket: WidgetSocket,
    schema: S,
    body: unknown,
    fn: (input: z.output<S>) => Promise<T>,
  ): Promise<WidgetAck<T>> {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: 'invalid_payload', message: 'That message does not match its schema' },
      };
    }
    try {
      return { ok: true, data: await fn(parsed.data) };
    } catch (error) {
      if (error instanceof WidgetFailure) {
        return { ok: false, error: { code: error.reason, message: error.message } };
      }
      this.#logger.error({ err: error }, 'A widget socket event failed');
      return {
        ok: false,
        error: { code: 'internal', message: 'The server could not handle that event' },
      };
    }
  }
}
