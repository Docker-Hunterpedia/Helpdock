import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { RedisStub } from '../testing/redis-stub.js';
import { STORAGE_USAGE_KEY, STORAGE_USAGE_MAX_AGE_MS, StorageUsageStore } from './storage-usage.js';

const BRAND = '01924f00-0000-7000-8000-0000000000aa';
const NOW = new Date('2026-10-05T09:07:00.000Z');

const storeOn = (redis: RedisStub) => new StorageUsageStore(redis as unknown as Redis);

describe('StorageUsageStore', () => {
  it('keeps one reading per brand and reads them all back', async () => {
    const store = storeOn(new RedisStub());
    await store.write({ brandId: BRAND, bytes: 2048, objects: 3, measuredAt: NOW.toISOString() });

    expect(await store.all()).toEqual([
      { brandId: BRAND, bytes: 2048, objects: 3, measuredAt: NOW.toISOString() },
    ]);
  });

  it('is stale with no reading, fresh after one, and stale again once it ages out', async () => {
    const store = storeOn(new RedisStub());
    expect(await store.isStale(BRAND, NOW)).toBe(true);

    await store.write({ brandId: BRAND, bytes: 1, objects: 1, measuredAt: NOW.toISOString() });

    expect(await store.isStale(BRAND, NOW)).toBe(false);
    expect(await store.isStale(BRAND, new Date(NOW.getTime() + STORAGE_USAGE_MAX_AGE_MS + 1))).toBe(
      true,
    );
  });

  it('leaves out a reading it cannot parse rather than guessing', async () => {
    const redis = new RedisStub();
    await redis.hset(STORAGE_USAGE_KEY, BRAND, 'not json');

    expect(await storeOn(redis).all()).toEqual([]);
    expect(await storeOn(redis).isStale(BRAND, NOW)).toBe(true);
  });

  it('forgets a purged brand', async () => {
    const store = storeOn(new RedisStub());
    await store.write({ brandId: BRAND, bytes: 1, objects: 1, measuredAt: NOW.toISOString() });
    await store.remove(BRAND);

    expect(await store.all()).toEqual([]);
  });
});
