import type { WidgetEnvelope, WidgetServerEvent } from '@helpdock/schemas';
import type { Redis } from 'ioredis';
import type { Namespace } from 'socket.io';
import type { Logger } from '../logging/logger.js';
import { quietly } from '../realtime/redis-io.adapter.js';
import {
  disconnectVisitorMessage,
  parseWidgetMessage,
  visitorRoom,
  WIDGET_EMIT_CHANNEL,
} from './widget-relay.js';

/**
 * The last hop on each api replica: a widget event off Redis, to this
 * replica's `/widget` sockets in the room and to this replica's SSE streams on
 * it. Both get the same envelope, which is §7's "identical event payloads".
 *
 * Local only, for the reason `RealtimeEmitSubscriber` gives: every replica
 * receives the message, so each delivers to its own clients and no more.
 */

export type StreamListener = (event: WidgetServerEvent, envelope: WidgetEnvelope<unknown>) => void;

export class WidgetHub {
  readonly #redis: Redis;
  readonly #logger: Logger;
  readonly #streams = new Map<string, Set<StreamListener>>();
  readonly #streamsOfVisitor = new Map<string, Set<() => void>>();
  #namespace: Namespace | null = null;
  #subscriber: Redis | null = null;

  constructor(redis: Redis, logger: Logger) {
    this.#redis = redis;
    this.#logger = logger;
  }

  /** Called by the gateway once Nest has created `/widget`. */
  bind(namespace: Namespace): void {
    this.#namespace = namespace;
  }

  async start(): Promise<void> {
    const subscriber = this.#redis.duplicate();
    subscriber.on('error', (error: Error) => {
      this.#logger.error({ err: error }, 'The widget emit subscriber failed');
    });
    subscriber.on('message', (channel: string, message: string) => {
      if (channel === WIDGET_EMIT_CHANNEL) {
        this.deliver(message);
      }
    });
    await subscriber.subscribe(WIDGET_EMIT_CHANNEL);
    this.#subscriber = subscriber;
  }

  async stop(): Promise<void> {
    const subscriber = this.#subscriber;
    this.#subscriber = null;
    this.#streams.clear();
    this.#streamsOfVisitor.clear();
    await quietly(subscriber);
  }

  /** Past `#` so a test can deliver without Redis; the message crossed a process boundary. */
  deliver(message: string): void {
    const parsed = parseWidgetMessage(message);
    if (parsed === null) {
      this.#logger.warn('Ignored a malformed widget emit message');
      return;
    }
    if (parsed.kind === 'disconnect-visitor') {
      for (const close of [...(this.#streamsOfVisitor.get(parsed.visitorId) ?? [])]) {
        close();
      }
      return;
    }

    const { room, event, envelope } = parsed;
    this.#namespace?.local.to(room).emit(event, envelope);
    for (const listener of this.#streams.get(room) ?? []) {
      listener(event, envelope);
    }
  }

  /**
   * Disconnects every `/widget` socket the visitor has, and ends every SSE
   * stream, on every replica: a room's membership was judged once, at join (a
   * stream's access once, at open), and outlives whatever granted it. The
   * client reconnects and each `conversation:join`, or stream open, is judged
   * afresh.
   *
   * The sockets go through the socket.io adapter; the streams through the
   * widget channel, because they live in this class and not in the adapter.
   * A failure to publish is logged, not thrown: the caller has already
   * committed the change, and a retry would find nothing left to withdraw.
   */
  async disconnectVisitor(visitorId: string): Promise<void> {
    this.#namespace?.in(visitorRoom(visitorId)).disconnectSockets(true);
    try {
      await this.#redis.publish(WIDGET_EMIT_CHANNEL, disconnectVisitorMessage(visitorId));
    } catch (error) {
      this.#logger.error({ err: error, visitorId }, 'Could not end a visitor’s SSE streams');
    }
  }

  /**
   * An SSE stream's claim on its visitor, so {@link disconnectVisitor} can end
   * it. Returns the unregister, which the stream calls when it ends.
   */
  watchVisitor(visitorId: string, close: () => void): () => void {
    const watchers = this.#streamsOfVisitor.get(visitorId) ?? new Set<() => void>();
    watchers.add(close);
    this.#streamsOfVisitor.set(visitorId, watchers);

    return () => {
      watchers.delete(close);
      if (watchers.size === 0) {
        this.#streamsOfVisitor.delete(visitorId);
      }
    };
  }

  /** An SSE stream's subscription to a room. Returns the unsubscribe. */
  listen(room: string, listener: StreamListener): () => void {
    const listeners = this.#streams.get(room) ?? new Set<StreamListener>();
    listeners.add(listener);
    this.#streams.set(room, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.#streams.delete(room);
      }
    };
  }

  /** Open SSE streams on this replica, for the gauge and the tests. */
  streamCount(): number {
    let count = 0;
    for (const listeners of this.#streams.values()) {
      count += listeners.size;
    }
    return count;
  }
}
