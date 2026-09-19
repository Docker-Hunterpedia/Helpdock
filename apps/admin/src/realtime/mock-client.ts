import type { PresenceMap, PresenceStatus, SettablePresenceStatus } from '@helpdock/schemas';
import { MOCK_USER } from '../auth/mock-api.js';
import { type RealtimeClient, type RealtimeListener, RealtimeListeners } from './client.js';

/**
 * The fixture the browser tests and `pnpm dev` run against, chosen by the same
 * `VITE_AUTH_API` switch as `MockAuthApi`.
 *
 * It is a real implementation of the contract rather than a stub of it: the
 * status it reports changes when the toggle is used and the change is announced
 * to every listener, so the shell exercises the states it will in production.
 * A second colleague is present so a screen that renders other people's
 * presence has something to render.
 */

export const MOCK_COLLEAGUE_ID = '0192c3f0-1a2b-7c3d-8e4f-00000000000b';

export class MockRealtimeClient implements RealtimeClient {
  readonly #listeners = new RealtimeListeners();
  readonly #userId: string;
  #status: PresenceStatus = 'offline';
  #brandId: string | null = null;

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
}
