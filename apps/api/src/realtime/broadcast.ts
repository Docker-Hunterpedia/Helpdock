import { REALTIME_EVENT_PAYLOADS, roomSchema, type ServerEvent } from '@helpdock/schemas';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { Logger } from '../logging/logger.js';
import { LOGGER, REDIS } from '../runtime/tokens.js';
import { RealtimePublisher } from './publisher.js';
import { quietly } from './redis-io.adapter.js';

/**
 * The bridge from the worker to the sockets.
 *
 * `APP_ROLE=worker` drains the queues and runs no Nest application, so it holds
 * no Socket.IO namespace and cannot emit. `APP_ROLE=api` holds the sockets and
 * runs no queue. A side effect that ends in a socket frame therefore crosses
 * one process boundary, and it crosses it over Redis pub/sub — the same channel
 * shape `principal.revoked` already uses (M0-05), rather than a second
 * mechanism to understand.
 */

export const REALTIME_EMIT_CHANNEL = 'helpdock:realtime:emit';

/** What travels on the channel. Parsed on arrival; it crosses a process boundary. */
export const realtimeEmitSchema = z.object({
  rooms: z.array(roomSchema).min(1).max(16),
  event: z.string().min(1).max(64),
  data: z.unknown(),
  /** The cursor of DOMAIN-RULES §7, or null for an event nothing replays. */
  seq: z.int().nonnegative().nullable(),
});
export type RealtimeEmit = z.infer<typeof realtimeEmitSchema>;

export interface RealtimeBroadcastInput {
  readonly rooms: readonly string[];
  readonly event: ServerEvent;
  readonly data: unknown;
  readonly seq: number | null;
}

/** What a worker-side caller sees. One method, so a test passes a recorder. */
export interface RealtimeBroadcast {
  emit(input: RealtimeBroadcastInput): Promise<void>;
}

/**
 * The worker's half: publish and forget. It never waits for a subscriber and
 * never reports one, because a caller must not be able to make a domain change
 * depend on a socket being connected (§7).
 */
export class RedisRealtimeBroadcast implements RealtimeBroadcast {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async emit({ rooms, event, data, seq }: RealtimeBroadcastInput): Promise<void> {
    await this.#redis.publish(
      REALTIME_EMIT_CHANNEL,
      JSON.stringify({ rooms: [...rooms], event, data, seq }),
    );
  }
}

/**
 * The api's half: every replica subscribes, and every replica emits to **its
 * own** sockets only.
 *
 * That is why {@link RealtimePublisher.emitToRoom} is called with
 * `local: true`. The Socket.IO Redis adapter already makes a normal emit reach
 * every replica; combined with a message every replica receives, a room would
 * hear the same frame once per replica. The fan-out has already happened by the
 * time this runs — Redis did it — so each replica does the last hop alone.
 */
@Injectable()
export class RealtimeEmitSubscriber implements OnModuleInit, OnModuleDestroy {
  readonly #redis: Redis;
  readonly #publisher: RealtimePublisher;
  readonly #logger: Logger;
  #subscriber: Redis | null = null;

  constructor(
    @Inject(REDIS) redis: Redis,
    @Inject(RealtimePublisher) publisher: RealtimePublisher,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.#redis = redis;
    this.#publisher = publisher;
    this.#logger = logger;
  }

  async onModuleInit(): Promise<void> {
    // A subscribed ioredis client accepts no other command, and the Socket.IO
    // adapter has subscriptions of its own on connections it owns.
    const subscriber = this.#redis.duplicate();
    subscriber.on('error', (error: Error) => {
      this.#logger.error({ err: error }, 'The realtime emit subscriber failed');
    });
    subscriber.on('message', (channel: string, message: string) => {
      if (channel === REALTIME_EMIT_CHANNEL) {
        this.deliver(message);
      }
    });

    await subscriber.subscribe(REALTIME_EMIT_CHANNEL);
    this.#subscriber = subscriber;
  }

  async onModuleDestroy(): Promise<void> {
    const subscriber = this.#subscriber;
    this.#subscriber = null;
    await quietly(subscriber);
  }

  /**
   * Past `#` so a test can deliver a message without a Redis. The payload is
   * parsed rather than trusted: it crosses a process boundary, and anything
   * with `PUBLISH` on this Redis can write to the channel.
   */
  deliver(message: string): void {
    const parsed = realtimeEmitSchema.safeParse(safeJson(message));
    if (!parsed.success) {
      this.#logger.warn('Ignored a malformed realtime emit message');
      return;
    }

    const { rooms, event, data, seq } = parsed.data;
    if (!isServerEvent(event)) {
      // A replica running an older build does not know an event a newer worker
      // published. Dropping it is right: the screen re-reads over REST anyway.
      this.#logger.warn({ event }, 'Ignored a realtime emit for an unknown event');
      return;
    }

    for (const room of rooms) {
      this.#publisher.emitToRoom(room, event, data as never, {
        ...(seq === null ? {} : { seq }),
        local: true,
      });
    }
  }
}

const isServerEvent = (event: string): event is ServerEvent =>
  Object.hasOwn(REALTIME_EVENT_PAYLOADS, event);

const safeJson = (message: string): unknown => {
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
};
