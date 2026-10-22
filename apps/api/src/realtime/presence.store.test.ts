import { PRESENCE_SOCKET_TTL_SECONDS } from '@helpdock/schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { RedisStub } from '../testing/redis-stub.js';
import { PresenceStore, presenceActiveKey, presenceSocketKey } from './presence.store.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const OTHER_BRAND = '01937f5e-7e53-7000-8000-00000000000b';
const LINA = '01937f5e-7e53-7000-8000-000000000001';
const OMAR = '01937f5e-7e53-7000-8000-000000000002';

describe('PresenceStore', () => {
  let redis: RedisStub;
  let store: PresenceStore;

  let clock: number;

  beforeEach(() => {
    redis = new RedisStub();
    clock = 1_000_000;
    redis.clock = () => clock;
    store = new PresenceStore(redis.asRedis());
  });

  it('announces an arrival once, however many tabs the person opens', async () => {
    expect(await store.join({ brandId: BRAND, userId: LINA, socketId: 's1' })).toEqual({
      arrived: true,
    });
    expect(await store.join({ brandId: BRAND, userId: LINA, socketId: 's2' })).toEqual({
      arrived: false,
    });
    expect(await store.map(BRAND)).toEqual({ [LINA]: 'online' });
  });

  it('keeps someone present until their last socket goes', async () => {
    await store.join({ brandId: BRAND, userId: LINA, socketId: 's1' });
    await store.join({ brandId: BRAND, userId: LINA, socketId: 's2' });

    expect(await store.leave({ brandId: BRAND, userId: LINA, socketId: 's1' })).toEqual({
      departed: false,
    });
    expect(await store.leave({ brandId: BRAND, userId: LINA, socketId: 's2' })).toEqual({
      departed: true,
    });
    expect(await store.map(BRAND)).toEqual({});
  });

  it('gives the liveness key a TTL so a crashed replica cleans itself up', async () => {
    await store.join({ brandId: BRAND, userId: LINA, socketId: 's1' });

    expect(redis.ttlOf(presenceSocketKey('s1'))).toBe(PRESENCE_SOCKET_TTL_SECONDS);
  });

  it('keeps brands apart', async () => {
    await store.join({ brandId: BRAND, userId: LINA, socketId: 's1' });
    await store.join({ brandId: OTHER_BRAND, userId: OMAR, socketId: 's2' });

    expect(await store.map(BRAND)).toEqual({ [LINA]: 'online' });
    expect(await store.map(OTHER_BRAND)).toEqual({ [OMAR]: 'online' });
    expect([...(await store.brands())].sort()).toEqual([BRAND, OTHER_BRAND].sort());
  });

  describe('the explicit toggle', () => {
    it('sets away and clears it again', async () => {
      await store.join({ brandId: BRAND, userId: LINA, socketId: 's1' });

      expect(await store.setStatus({ brandId: BRAND, userId: LINA }, 'away')).toBe(true);
      expect(await store.map(BRAND)).toEqual({ [LINA]: 'away' });

      await store.setStatus({ brandId: BRAND, userId: LINA }, 'online');
      expect(await store.map(BRAND)).toEqual({ [LINA]: 'online' });
    });

    it('refuses someone who is not present: they are offline, not away', async () => {
      expect(await store.setStatus({ brandId: BRAND, userId: LINA }, 'away')).toBe(false);
    });

    it('is forgotten when they go offline, so the next sign-in starts online', async () => {
      await store.join({ brandId: BRAND, userId: LINA, socketId: 's1' });
      await store.setStatus({ brandId: BRAND, userId: LINA }, 'away');
      await store.leave({ brandId: BRAND, userId: LINA, socketId: 's1' });

      await store.join({ brandId: BRAND, userId: LINA, socketId: 's2' });
      expect(await store.map(BRAND)).toEqual({ [LINA]: 'online' });
    });
  });

  describe('sweeping', () => {
    it('leaves someone alone while any liveness key survives', async () => {
      await store.join({ brandId: BRAND, userId: LINA, socketId: 's1' });
      await store.join({ brandId: BRAND, userId: LINA, socketId: 's2' });
      await redis.del(presenceSocketKey('s1'));

      expect(await store.sweepUser(BRAND, LINA)).toEqual({ departed: false });
      expect(await store.map(BRAND)).toEqual({ [LINA]: 'online' });
    });

    it('takes someone offline once every liveness key has expired', async () => {
      await store.join({ brandId: BRAND, userId: LINA, socketId: 's1' });
      await redis.del(presenceSocketKey('s1'));

      expect(await store.sweepUser(BRAND, LINA)).toEqual({ departed: true });
      expect(await store.map(BRAND)).toEqual({});
    });

    it('answers departed only once, so two replicas sweeping emit one event', async () => {
      await store.join({ brandId: BRAND, userId: LINA, socketId: 's1' });
      await redis.del(presenceSocketKey('s1'));

      const first = await store.sweepUser(BRAND, LINA);
      const second = await store.sweepUser(BRAND, LINA);

      expect([first.departed, second.departed]).toEqual([true, false]);
    });

    it('drops the brand from the work list once it is empty', async () => {
      await store.join({ brandId: BRAND, userId: LINA, socketId: 's1' });
      await store.join({ brandId: OTHER_BRAND, userId: OMAR, socketId: 's2' });
      await store.leave({ brandId: BRAND, userId: LINA, socketId: 's1' });

      // Otherwise every brand that has ever had a socket stays on the reaper's
      // list for the life of the install.
      expect(await store.brands()).toEqual([OTHER_BRAND]);
    });
  });

  describe('heartbeats', () => {
    it('refreshes the liveness key without announcing anything', async () => {
      await store.join({ brandId: BRAND, userId: LINA, socketId: 's1' });

      const { repaired } = await store.heartbeat('s1', [
        { brandId: BRAND, userId: LINA, socketId: 's1' },
      ]);

      expect(repaired).toEqual([]);
      expect(redis.ttlOf(presenceSocketKey('s1'))).toBe(PRESENCE_SOCKET_TTL_SECONDS);
    });

    it('puts back someone a sweep dropped a moment too early, and says so', async () => {
      await store.join({ brandId: BRAND, userId: LINA, socketId: 's1' });
      await redis.del(presenceSocketKey('s1'));
      await store.sweepUser(BRAND, LINA);

      const { repaired } = await store.heartbeat('s1', [
        { brandId: BRAND, userId: LINA, socketId: 's1' },
      ]);

      expect(repaired).toEqual([{ brandId: BRAND, userId: LINA, socketId: 's1' }]);
      expect(await store.map(BRAND)).toEqual({ [LINA]: 'online' });
    });

    it('covers every brand room one socket has joined', async () => {
      await store.join({ brandId: BRAND, userId: LINA, socketId: 's1' });
      await store.join({ brandId: OTHER_BRAND, userId: LINA, socketId: 's1' });

      const { repaired } = await store.heartbeat('s1', [
        { brandId: BRAND, userId: LINA, socketId: 's1' },
        { brandId: OTHER_BRAND, userId: LINA, socketId: 's1' },
      ]);

      expect(repaired).toEqual([]);
    });
  });

  describe('idle away (M14-18)', () => {
    const lina = { brandId: BRAND, userId: LINA };
    const MINUTE = 60_000;
    const stamp = async (): Promise<number | null> => {
      const at = await redis.hget(presenceActiveKey(BRAND), LINA);

      return at === null ? null : Number(at);
    };
    /** Marks idle if their last report is `limit` minutes old at `clock`. */
    const markIdle = (limit = 0) => store.markIdleIfStale(BRAND, LINA, limit * MINUTE);

    it('stamps the first arrival only, so a second tab does not restart the clock', async () => {
      await store.join({ ...lina, socketId: 's1' });
      clock += 5 * 60_000;
      await store.join({ ...lina, socketId: 's2' });

      expect(await stamp()).toBe(1_000_000);
    });

    it('marks idle once, and shows the person as away', async () => {
      await store.join({ ...lina, socketId: 's1' });

      expect(await markIdle()).toBe(true);
      expect(await markIdle()).toBe(false);
      expect(await store.map(BRAND)).toEqual({ [LINA]: 'away' });
      expect(await store.statusOf(BRAND, LINA)).toBe('away');
    });

    it('does not mark someone with no socket idle: they are offline', async () => {
      expect(await markIdle()).toBe(false);
      expect(await store.map(BRAND)).toEqual({});
    });

    it('ends the idle away on activity, once, and refreshes the clock', async () => {
      await store.join({ ...lina, socketId: 's1' });
      await markIdle();
      clock += 60_000;

      expect(await store.touch(lina)).toEqual({ present: true, idleEnded: true });
      expect(await store.touch(lina)).toEqual({ present: true, idleEnded: false });
      expect(await stamp()).toBe(clock);
      expect(await store.statusOf(BRAND, LINA)).toBe('online');
    });

    it('lets activity lift the idle reason but never an explicit away', async () => {
      await store.join({ ...lina, socketId: 's1' });
      await store.setStatus(lina, 'away');
      await markIdle();

      expect(await store.touch(lina)).toEqual({ present: true, idleEnded: true });
      expect(await store.statusOf(BRAND, LINA)).toBe('away');
    });

    it('treats activity from someone with no socket as nothing', async () => {
      expect(await store.touch(lina)).toEqual({ present: false, idleEnded: false });
      expect(await stamp()).toBeNull();
    });

    it('is ended by saying online from the menu, which is activity too', async () => {
      await store.join({ ...lina, socketId: 's1' });
      await markIdle();

      await store.setStatus(lina, 'online');

      expect(await store.statusOf(BRAND, LINA)).toBe('online');
    });

    it('keeps one clock for the person across tabs, and one idle state', async () => {
      await store.join({ ...lina, socketId: 's1' });
      await store.join({ ...lina, socketId: 's2' });
      await markIdle();
      await store.leave({ ...lina, socketId: 's1' });

      expect(await store.statusOf(BRAND, LINA)).toBe('away');
      // A report made from the other tab ends it for the person.
      expect(await store.touch(lina)).toEqual({ present: true, idleEnded: true });
    });

    it('forgets the clock and the idle mark when the person goes offline', async () => {
      await store.join({ ...lina, socketId: 's1' });
      await markIdle();
      await store.leave({ ...lina, socketId: 's1' });
      clock += 1_000;

      await store.join({ ...lina, socketId: 's2' });

      expect(await store.statusOf(BRAND, LINA)).toBe('online');
      expect(await stamp()).toBe(clock);
    });

    it('keeps brands apart', async () => {
      await store.join({ ...lina, socketId: 's1' });
      await store.join({ brandId: OTHER_BRAND, userId: LINA, socketId: 's2' });
      await markIdle();

      expect(await store.statusOf(OTHER_BRAND, LINA)).toBe('online');
      expect(await store.idleUsers(OTHER_BRAND)).toEqual([]);
    });

    it('starts a missing clock from now instead of marking idle, and then counts from it', async () => {
      await store.join({ ...lina, socketId: 's1' });
      await redis.hdel(presenceActiveKey(BRAND), LINA);
      clock += 40 * MINUTE;

      expect(await markIdle(30)).toBe(false);
      expect(await stamp()).toBe(clock);

      clock += 30 * MINUTE - 1;
      expect(await markIdle(30)).toBe(false);
      clock += 1;
      expect(await markIdle(30)).toBe(true);
    });

    it('marks idle only once the last report is old enough, never one millisecond sooner', async () => {
      await store.join({ ...lina, socketId: 's1' });
      clock += 10 * MINUTE - 1;
      expect(await markIdle(10)).toBe(false);

      clock += 1;
      expect(await markIdle(10)).toBe(true);
    });

    it('does not mark someone who reported after the limit was last read', async () => {
      await store.join({ ...lina, socketId: 's1' });
      clock += 30 * MINUTE;
      await store.touch(lina);

      expect(await markIdle(30)).toBe(false);
      expect(await store.statusOf(BRAND, LINA)).toBe('online');
    });

    it('releases an idle mark once, for the one caller that does', async () => {
      await store.join({ ...lina, socketId: 's1' });
      await markIdle();

      expect(await store.idleUsers(BRAND)).toEqual([LINA]);
      expect(await store.releaseIdle(BRAND, LINA)).toBe(true);
      expect(await store.releaseIdle(BRAND, LINA)).toBe(false);
    });
  });
});
