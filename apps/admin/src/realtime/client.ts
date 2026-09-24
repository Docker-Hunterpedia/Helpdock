import type {
  AttachmentChanged,
  PresenceChanged,
  PresenceMap,
  SettablePresenceStatus,
  TicketChanged,
  TicketMessageEvent,
  TicketViewing,
  TicketViewingActivity,
} from '@helpdock/schemas';

/**
 * What the admin needs from the realtime gateway, and nothing else.
 *
 * Two implementations sit behind it: `SocketRealtimeClient`, which is a real
 * Socket.IO connection to `/staff`, and `MockRealtimeClient`, which the
 * browser tests and `pnpm dev` run against. The screens see only this, so no
 * component has a socket to mishandle.
 */

export type RealtimeConnection = 'connecting' | 'connected' | 'closed';

export interface RealtimeListener {
  connection?(state: RealtimeConnection): void;
  presenceChanged?(change: PresenceChanged): void;
  /**
   * The media pipeline finished with an attachment (M1-10). It is a
   * notification, not the truth: the composer re-reads the row over REST, which
   * is what {@link ../media/use-attachment.js useAttachment} does with it
   * (DOMAIN-RULES §7).
   */
  attachmentChanged?(change: AttachmentChanged): void;
  /** A ticket was created or something about it moved. Ids only; a screen re-reads. */
  ticketChanged?(change: TicketChanged): void;
  /** A message was added. Its `seq` is what a thread catches up from (§7). */
  ticketMessage?(event: TicketMessageEvent): void;
  /** Somebody else has this ticket open, for the collision indicator. */
  ticketViewing?(viewing: TicketViewing): void;
}

export interface RealtimeClient {
  /** Opens the connection and joins `brand:<brandId>`. Repeat calls re-target it. */
  start(brandId: string): void;
  stop(): void;
  /** The map REST answers with, which is the truth a screen renders first (DOMAIN-RULES §7). */
  presence(brandId: string): Promise<PresenceMap>;
  setPresence(status: SettablePresenceStatus): Promise<void>;
  /**
   * Joins a room until the returned handle is called, and re-joins it after a
   * reconnect. A handle rather than a `leave(room)` because two screens may
   * want the same room and only the last one to let go may leave it — a ticket
   * open beside the department queue it came from is exactly that.
   */
  joinRoom(room: string): () => void;
  /**
   * Says "I have this ticket open" to the rest of `ticket:<ticketId>`, and —
   * M1-09 — whether the composer has something in it (`replying`).
   */
  announceViewing(ticketId: string, activity?: TicketViewingActivity): void;
  subscribe(listener: RealtimeListener): () => void;
}

/** Shared by both implementations: a listener set with an unsubscribe handle. */
export class RealtimeListeners {
  readonly #listeners = new Set<RealtimeListener>();

  add(listener: RealtimeListener): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  connection(state: RealtimeConnection): void {
    this.#each((listener) => listener.connection?.(state));
  }

  presenceChanged(change: PresenceChanged): void {
    this.#each((listener) => listener.presenceChanged?.(change));
  }

  ticketChanged(change: TicketChanged): void {
    this.#each((listener) => listener.ticketChanged?.(change));
  }

  ticketMessage(event: TicketMessageEvent): void {
    this.#each((listener) => listener.ticketMessage?.(event));
  }

  ticketViewing(viewing: TicketViewing): void {
    this.#each((listener) => listener.ticketViewing?.(viewing));
  }

  /** Over a copy, so a listener that unsubscribes itself cannot skip the next. */
  #each(deliver: (listener: RealtimeListener) => void): void {
    for (const listener of [...this.#listeners]) {
      deliver(listener);
    }
  }

  attachmentChanged(change: AttachmentChanged): void {
    for (const listener of [...this.#listeners]) {
      listener.attachmentChanged?.(change);
    }
  }
}

/**
 * The rooms a client wants to be in, counted rather than listed: two screens
 * may hold the same room, and it is left when the last of them lets go.
 *
 * It is its own class rather than state inside the socket client because both
 * implementations follow the same rule and neither should own it.
 */
export class RoomMemberships {
  readonly #counts = new Map<string, number>();

  /** True when this is the first holder, which is when a join has to be sent. */
  acquire(room: string): boolean {
    const count = this.#counts.get(room) ?? 0;
    this.#counts.set(room, count + 1);

    return count === 0;
  }

  /** True when the last holder let go, which is when a leave has to be sent. */
  release(room: string): boolean {
    const count = this.#counts.get(room) ?? 0;
    if (count <= 1) {
      this.#counts.delete(room);

      return count === 1;
    }

    this.#counts.set(room, count - 1);

    return false;
  }

  /** Every room still wanted, which is what a reconnect re-joins. */
  rooms(): readonly string[] {
    return [...this.#counts.keys()];
  }

  clear(): void {
    this.#counts.clear();
  }
}
