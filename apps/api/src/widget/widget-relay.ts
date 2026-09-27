import {
  WIDGET_EVENT_PAYLOADS,
  type WidgetEnvelope,
  type WidgetServerEvent,
  type WidgetServerEventPayload,
} from '@helpdock/schemas';
import type { Redis } from 'ioredis';
import { z } from 'zod';

/**
 * How a widget event reaches a visitor, whichever process caused it and
 * whichever replica the visitor is connected to (DOMAIN-RULES §7).
 *
 * ```
 * worker (agent reply)  ─┐
 * api (typing, presence) ─┴─> Redis `helpdock:realtime:widget` ─> every api replica
 *                                                                  ├─ its /widget sockets in the room
 *                                                                  └─ its SSE streams on the room
 * ```
 *
 * One channel for both transports, which is what makes the SSE fallback carry
 * "identical event payloads": a socket frame and an SSE event are built from
 * the same envelope by the same subscriber. It is the staff bridge's shape
 * (`realtime/broadcast.ts`) on a channel of its own, because the staff
 * publisher is bound to `/staff` and a visitor must never be in a staff room.
 */

export const WIDGET_EMIT_CHANNEL = 'helpdock:realtime:widget';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A widget room. `conversation:<ticketId>` is one conversation's watchers;
 * `visitors:<brandId>` is every visitor of a brand, for presence.
 */
export const conversationRoom = (conversationId: string): string =>
  `conversation:${conversationId}`;
export const brandVisitorsRoom = (brandId: string): string => `visitors:${brandId}`;

export const widgetRoomSchema = z.string().refine((room) => {
  const [kind, id = ''] = room.split(':');
  return (kind === 'conversation' || kind === 'visitors') && UUID.test(id);
}, 'must be conversation:<uuid> or visitors:<uuid>');

export const widgetEmitSchema = z.object({
  room: widgetRoomSchema,
  event: z.string().min(1).max(64),
  data: z.unknown(),
  seq: z.int().positive().nullable(),
});

export interface WidgetEmitInput<E extends WidgetServerEvent> {
  readonly room: string;
  readonly event: E;
  readonly data: WidgetServerEventPayload<E>;
  /** The message's `seq`; null for the ephemeral events (§7). */
  readonly seq: number | null;
}

/** What a publisher sees. One method, so a test passes a recorder. */
export interface WidgetBroadcast {
  emit<E extends WidgetServerEvent>(input: WidgetEmitInput<E>): Promise<void>;
}

export class RedisWidgetBroadcast implements WidgetBroadcast {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async emit<E extends WidgetServerEvent>({
    room,
    event,
    data,
    seq,
  }: WidgetEmitInput<E>): Promise<void> {
    // Parsed on the way in too, so a caller that built the wrong shape finds
    // out here rather than as a frame every replica drops.
    const payload = WIDGET_EVENT_PAYLOADS[event].parse(data);
    await this.#redis.publish(
      WIDGET_EMIT_CHANNEL,
      JSON.stringify({ room: widgetRoomSchema.parse(room), event, data: payload, seq }),
    );
  }
}

export const isWidgetServerEvent = (event: string): event is WidgetServerEvent =>
  Object.hasOwn(WIDGET_EVENT_PAYLOADS, event);

export const widgetEnvelope = <E extends WidgetServerEvent>(
  event: E,
  data: unknown,
  seq: number | null,
  at: Date = new Date(),
): WidgetEnvelope<WidgetServerEventPayload<E>> => ({
  seq,
  at: at.toISOString(),
  data: WIDGET_EVENT_PAYLOADS[event].parse(data) as WidgetServerEventPayload<E>,
});

/** A parsed message off the channel, or null for anything malformed or unknown. */
export const parseWidgetEmit = (
  message: string,
): {
  readonly room: string;
  readonly event: WidgetServerEvent;
  readonly envelope: WidgetEnvelope<unknown>;
} | null => {
  let json: unknown;
  try {
    json = JSON.parse(message);
  } catch {
    return null;
  }

  const parsed = widgetEmitSchema.safeParse(json);
  if (!parsed.success || !isWidgetServerEvent(parsed.data.event)) {
    return null;
  }

  const { room, event, data, seq } = parsed.data;
  const payload = WIDGET_EVENT_PAYLOADS[event].safeParse(data);
  if (!payload.success) {
    return null;
  }

  return { room, event, envelope: { seq, at: new Date().toISOString(), data: payload.data } };
};
