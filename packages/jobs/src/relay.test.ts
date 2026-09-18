import type { Db } from '@helpdock/db';
import { describe, expect, it, vi } from 'vitest';
import { advisoryLockKey, chunk, runRelayCycle } from './relay.js';

const brandA = '01924f00-0000-7000-8000-0000000000aa';
const brandB = 'ffffffff-0000-7000-8000-0000000000bb';

describe('advisoryLockKey', () => {
  it('is the same key every time, so two replicas contend on it', () => {
    expect(advisoryLockKey(brandA)).toBe(advisoryLockKey(brandA));
  });

  it('separates two brands', () => {
    expect(advisoryLockKey(brandA)).not.toBe(advisoryLockKey(brandB));
  });

  it('fits the signed int4 Postgres takes', () => {
    for (const brandId of [brandA, brandB]) {
      const key = advisoryLockKey(brandId);
      expect(Number.isInteger(key)).toBe(true);
      expect(key).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(key).toBeLessThan(2 ** 31);
    }
  });

  it('turns the high bit into a negative key rather than overflowing', () => {
    expect(advisoryLockKey(brandB)).toBeLessThan(0);
  });

  it('refuses anything that is not a brand uuid', () => {
    expect(() => advisoryLockKey('acme')).toThrow(TypeError);
  });
});

describe('chunk', () => {
  it('splits into runs of the given size and keeps the remainder', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns nothing for an empty list', () => {
    expect(chunk([], 50)).toEqual([]);
  });

  it.each([0, -1, 2.5])('refuses a size of %s', (size) => {
    expect(() => chunk([1, 2], size)).toThrow(RangeError);
  });
});

describe('runRelayCycle', () => {
  it('does nothing when it owns no brands, without touching the database', async () => {
    const queue = { add: vi.fn() };
    const db = {
      select: () => {
        throw new Error('the relay must not query when it owns no brands');
      },
    } as unknown as Db;

    expect(await runRelayCycle({ db, queue, brandIds: [] })).toEqual({
      published: 0,
      brands: 0,
      skipped: 0,
      failed: 0,
      hasMore: false,
    });
    expect(queue.add).not.toHaveBeenCalled();
  });
});
