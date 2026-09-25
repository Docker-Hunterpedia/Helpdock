import type { PresenceStatus } from '@helpdock/schemas';
import type { Redis } from 'ioredis';
import type { PresenceStore } from '../realtime/presence.store.js';
import type { OfflineSinceStore, PresenceLookup } from './assignment-events.js';
import type { PresenceReader } from './auto-assign.js';

/**
 * M0-13's presence, as the two questions M1-07 asks of it. Presence lives in
 * Redis and every api replica and the worker read the same keys, so the
 * worker's answer is the one the staff list shows.
 */
export class StorePresenceReader implements PresenceReader, PresenceLookup {
  readonly #store: PresenceStore;

  constructor(store: PresenceStore) {
    this.#store = store;
  }

  async online(brandId: string): Promise<ReadonlySet<string>> {
    const map = await this.#store.map(brandId);

    return new Set(
      Object.entries(map)
        .filter(([, status]) => status === 'online')
        .map(([userId]) => userId),
    );
  }

  statusOf(brandId: string, userId: string): Promise<PresenceStatus> {
    return this.#store.statusOf(brandId, userId);
  }
}

export const offlineSinceKey = (brandId: string, userId: string): string =>
  `assignment:offline-since:${brandId}:${userId}`;

/** Longer than the longest timer a department may set (a day), so no live timer outlives its key. */
const OFFLINE_SINCE_TTL_SECONDS = 2 * 24 * 60 * 60;

export class RedisOfflineSinceStore implements OfflineSinceStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async set(brandId: string, userId: string, since: string): Promise<void> {
    // Only ever forwards: a redelivered older departure must not overwrite a
    // newer one and revive the timer it superseded.
    const current = await this.#redis.get(offlineSinceKey(brandId, userId));
    if (current !== null && Date.parse(current) >= Date.parse(since)) {
      return;
    }

    await this.#redis.set(offlineSinceKey(brandId, userId), since, 'EX', OFFLINE_SINCE_TTL_SECONDS);
  }

  get(brandId: string, userId: string): Promise<string | null> {
    return this.#redis.get(offlineSinceKey(brandId, userId));
  }
}
