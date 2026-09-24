import type {
  PresenceMap,
  PresenceStatus,
  SettablePresenceStatus,
  TicketChanged,
  TicketMessageEvent,
  TicketViewing,
  TicketViewingActivity,
} from '@helpdock/schemas';
import { parseRoom } from '@helpdock/schemas';
import { MOCK_USER } from '../auth/mock-api.js';
import {
  type RealtimeClient,
  type RealtimeListener,
  RealtimeListeners,
  RoomMemberships,
} from './client.js';

/**
 * The fixture the browser tests and `pnpm dev` run against, chosen by the same
 * `VITE_AUTH_API` switch as `MockAuthApi`.
 *
 * It is a real implementation of the contract rather than a stub of it: the
 * status it reports changes when the toggle is used and the change is announced
 * to every listener, so the shell exercises the states it will in production.
 * A second colleague is present so a screen that renders other people's
 * presence has something to render.
 *
 * The rooms are kept rather than ignored, because "which rooms is this screen
 * in" is a thing the ticket workspace decides and therefore a thing a test has
 * to be able to read. Nothing is delivered into them by itself: the fixture has
 * no server, so `emit` is what a test uses to play the part of one.
 */

export const MOCK_COLLEAGUE_ID = '0192c3f0-1a2b-7c3d-8e4f-00000000000b';

/** Only used before `start`, which is the only moment there is no brand. */
const MOCK_BRAND_ID = '0192c3f0-1a2b-7c3d-8e4f-000000000001';

export class MockRealtimeClient implements RealtimeClient {
  readonly #listeners = new RealtimeListeners();
  readonly #memberships = new RoomMemberships();
  readonly #userId: string;
  #status: PresenceStatus = 'offline';
  #brandId: string | null = null;
  /** Every ticket this client has said it is looking at, in order. */
  readonly announced: string[] = [];
  /** What each of those announcements said this browser was doing (M1-09). */
  readonly announcedActivity: TicketViewingActivity[] = [];

  constructor(userId: string = MOCK_USER.id) {
    this.#userId = userId;
  }

  subscribe(listener: RealtimeListener): () => void {
    return this.#listeners.add(listener);
  }

  start(brandId: string): void {
    this.#brandId = brandId;
    this.#status = 'online';
    this.#listeners.connection('connected');
    this.#listeners.presenceChanged({ userId: this.#userId, brandId, status: 'online' });
  }

  stop(): void {
    const brandId = this.#brandId;
    this.#brandId = null;
    this.#status = 'offline';
    this.#memberships.clear();
    this.#listeners.connection('closed');
    if (brandId !== null) {
      this.#listeners.presenceChanged({ userId: this.#userId, brandId, status: 'offline' });
    }
  }

  presence(_brandId: string): Promise<PresenceMap> {
    return Promise.resolve({
      ...(this.#status === 'offline' ? {} : { [this.#userId]: this.#status }),
      [MOCK_COLLEAGUE_ID]: 'away' as const,
    });
  }

  setPresence(status: SettablePresenceStatus): Promise<void> {
    this.#status = status;
    if (this.#brandId !== null) {
      this.#listeners.presenceChanged({ userId: this.#userId, brandId: this.#brandId, status });
    }

    return Promise.resolve();
  }

  joinRoom(room: string): () => void {
    if (parseRoom(room) === null) {
      throw new Error(`not a room name: ${room}`);
    }
    this.#memberships.acquire(room);

    let held = true;

    return () => {
      if (held) {
        held = false;
        this.#memberships.release(room);
      }
    };
  }

  /**
   * The fixture plays the other side of the room: a colleague is looking at
   * whatever this browser says it has open, so the collision indicator has
   * something to draw in `pnpm dev`, in the browser suite and in the
   * screenshots. A real gateway relays other people's announcements; this one
   * has no other people, so it invents exactly one.
   */
  announceViewing(ticketId: string, activity: TicketViewingActivity = 'viewing'): void {
    this.announced.push(ticketId);
    this.announcedActivity.push(activity);
    // The colleague is looking, never typing: what this browser is doing is
    // this browser's, and the fixture has nobody else to be replying.
    this.#listeners.ticketViewing({
      brandId: this.#brandId ?? MOCK_BRAND_ID,
      ticketId,
      activity: 'viewing',
      userId: MOCK_COLLEAGUE_ID,
    });
  }

  /** Which rooms the screens on top of this client are asking for. */
  rooms(): readonly string[] {
    return this.#memberships.rooms();
  }

  // ---------------------------------------------------------------- testing

  /** Plays the server: what a ticket room would have been told. */
  emitTicketChanged(change: TicketChanged): void {
    this.#listeners.ticketChanged(change);
  }

  emitTicketMessage(event: TicketMessageEvent): void {
    this.#listeners.ticketMessage(event);
  }

  emitTicketViewing(viewing: TicketViewing): void {
    this.#listeners.ticketViewing(viewing);
  }

  /** A reconnection, which is what makes a screen catch up over REST (§7). */
  reconnect(): void {
    this.#listeners.connection('connecting');
    this.#listeners.connection('connected');
  }
}
