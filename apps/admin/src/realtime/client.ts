import type {
  AttachmentChanged,
  PresenceChanged,
  PresenceMap,
  SettablePresenceStatus,
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
}

export interface RealtimeClient {
  /** Opens the connection and joins `brand:<brandId>`. Repeat calls re-target it. */
  start(brandId: string): void;
  stop(): void;
  /** The map REST answers with, which is the truth a screen renders first (DOMAIN-RULES §7). */
  presence(brandId: string): Promise<PresenceMap>;
  setPresence(status: SettablePresenceStatus): Promise<void>;
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
    for (const listener of [...this.#listeners]) {
      listener.connection?.(state);
    }
  }

  presenceChanged(change: PresenceChanged): void {
    for (const listener of [...this.#listeners]) {
      listener.presenceChanged?.(change);
    }
  }

  attachmentChanged(change: AttachmentChanged): void {
    for (const listener of [...this.#listeners]) {
      listener.attachmentChanged?.(change);
    }
  }
}
