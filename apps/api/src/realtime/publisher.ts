import {
  REALTIME_EVENT_PAYLOADS,
  type RealtimeEnvelope,
  roomSchema,
  type ServerEvent,
  type ServerEventPayload,
} from '@helpdock/schemas';
import { Injectable } from '@nestjs/common';
import type { Namespace } from 'socket.io';

/**
 * The one way anything emits to a room. M1's ticket events, M3's notifications
 * and M4's widget deliveries all go through here, so there is a single place
 * where an outbound payload is checked and a single place where the envelope
 * of DOMAIN-RULES §7 is built.
 *
 * Nothing is persisted and nothing is replayed: "Socket.IO does not guarantee
 * delivery. The REST API is the source of truth; sockets are notifications."
 */
@Injectable()
export class RealtimePublisher {
  #namespace: Namespace | null = null;

  /** Called by the gateway once Nest has created the namespace. */
  bind(namespace: Namespace): void {
    this.#namespace = namespace;
  }

  /**
   * `seq` is the cursor a client catches up from. Ephemeral events pass
   * nothing and travel as `null` (DOMAIN-RULES §7).
   *
   * The payload is parsed on the way out for the same reason an HTTP response
   * is (ARCHITECTURE §6, step 5): a field nobody meant to send cannot leak, and
   * a caller that builds the wrong shape learns here rather than in a browser.
   */
  emitToRoom<E extends ServerEvent>(
    room: string,
    event: E,
    payload: ServerEventPayload<E>,
    options: { readonly seq?: number; readonly local?: boolean } = {},
  ): void {
    const namespace = this.#namespace;
    if (namespace === null) {
      // Before `afterInit` there is nothing to emit to. Dropping is right:
      // sockets are notifications, and a caller must never wait on one.
      return;
    }

    // `local` restricts the emit to this replica's own sockets. It is for the
    // one caller whose fan-out has already happened —
    // {@link ./broadcast.js RealtimeEmitSubscriber}, which every replica runs
    // on a message every replica receives. Without it the Redis adapter would
    // fan that message out again and a room would hear the frame once per
    // replica.
    const target = options.local === true ? namespace.local : namespace;

    target.to(roomSchema.parse(room)).emit(event, this.envelope(event, payload, options));
  }

  /**
   * Turns every socket of this replica out of a room, so the next thing a
   * client does is re-join and be authorised again.
   *
   * A room is authorised once, when it is joined. A ticket that moves
   * department changes who may read it, and a socket that joined while the
   * ticket was in the old department would otherwise keep hearing about it:
   * ids only, never a body, but "an internal note was just added to the ticket
   * you lost" is still more than nothing. `#requireLiveSession` covers a
   * revoked session; this covers a changed scope.
   *
   * Local, for the same reason {@link emitToRoom}'s `local` exists: every
   * replica is told, and each turns out its own.
   */
  evictRoom(room: string): void {
    const namespace = this.#namespace;
    /* c8 ignore next 3 -- there is nothing to evict before `afterInit`. */
    if (namespace === null) {
      return;
    }

    void namespace.local.in(roomSchema.parse(room)).socketsLeave(roomSchema.parse(room));
  }

  /** Exported for the tests, and because a seq-bearing envelope is worth naming. */
  envelope<E extends ServerEvent>(
    event: E,
    payload: ServerEventPayload<E>,
    options: { readonly seq?: number } = {},
  ): RealtimeEnvelope<ServerEventPayload<E>> {
    const schema = REALTIME_EVENT_PAYLOADS[event];

    return {
      seq: options.seq ?? null,
      at: new Date().toISOString(),
      data: schema.parse(payload) as ServerEventPayload<E>,
    };
  }
}
