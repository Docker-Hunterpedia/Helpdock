import { PRESENCE_SOCKET_TTL_SECONDS } from '@helpdock/schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { RedisStub } from '../testing/redis-stub.js';
import { PresenceStore, presenceSocketKey } from './presence.store.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const OTHER_BRAND = '01937f5e-7e53-7000-8000-00000000000b';
const LINA = '01937f5e-7e53-7000-8000-000000000001';
const OMAR = '01937f5e-7e53-7000-8000-000000000002';

describe('PresenceStore', () => {
  let redis: RedisStub;
  let store: PresenceStore;

  beforeEach(() => {
    redis = new RedisStub();
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
});
