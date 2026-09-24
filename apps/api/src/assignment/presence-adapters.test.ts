import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { PresenceStore } from '../realtime/presence.store.js';
import {
  offlineSinceKey,
  RedisOfflineSinceStore,
  StorePresenceReader,
} from './presence-adapters.js';

const brandId = '01920000-0000-7000-8000-000000000b00';

describe('StorePresenceReader', () => {
  const store = {
    map: async () => ({ lina: 'online', sara: 'away' }),
    statusOf: async () => 'away',
  } as unknown as PresenceStore;

  it('answers "online" with the people who are online, and not the ones who are away', async () => {
    expect(await new StorePresenceReader(store).online(brandId)).toEqual(new Set(['lina']));
  });

  it('passes a single status straight through', async () => {
    expect(await new StorePresenceReader(store).statusOf(brandId, 'sara')).toBe('away');
  });
});

describe('RedisOfflineSinceStore', () => {
  /** The two commands the store uses, over a map. */
  const fakeRedis = () => {
    const values = new Map<string, string>();
    const redis = {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => {
        values.set(key, value);
        return 'OK';
      },
    } as unknown as Redis;

    return { redis, values };
  };

  it('records a departure under a key per brand and person', async () => {
    const { redis, values } = fakeRedis();
    const store = new RedisOfflineSinceStore(redis);

    await store.set(brandId, 'lina', '2026-09-24T10:00:00.000Z');

    expect(values.get(offlineSinceKey(brandId, 'lina'))).toBe('2026-09-24T10:00:00.000Z');
    expect(await store.get(brandId, 'lina')).toBe('2026-09-24T10:00:00.000Z');
  });

  it('only ever moves forwards, so a late redelivery cannot revive a superseded timer', async () => {
    const { redis } = fakeRedis();
    const store = new RedisOfflineSinceStore(redis);

    await store.set(brandId, 'lina', '2026-09-24T10:05:00.000Z');
    await store.set(brandId, 'lina', '2026-09-24T10:00:00.000Z');
    expect(await store.get(brandId, 'lina')).toBe('2026-09-24T10:05:00.000Z');

    await store.set(brandId, 'lina', '2026-09-24T10:09:00.000Z');
    expect(await store.get(brandId, 'lina')).toBe('2026-09-24T10:09:00.000Z');
  });
});
