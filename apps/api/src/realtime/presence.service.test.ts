import { brandRoom, PRESENCE_REAPER_INTERVAL_MS, REALTIME_EVENTS } from '@helpdock/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisStub } from '../testing/redis-stub.js';
import { silentLogger } from '../testing/silent-logger.js';
import type { IdleAwayPolicy } from './idle-away.policy.js';
import { PresenceService } from './presence.service.js';
import { PresenceStore, presenceActiveKey, presenceSocketKey } from './presence.store.js';
import { RealtimePublisher } from './publisher.js';
import type { StaffOfflineHook } from './staff-offline.hook.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const LINA = '01937f5e-7e53-7000-8000-000000000001';

/** What `presence:changed` carried, without the envelope plumbing. */
interface Announcement {
  readonly room: string;
  readonly status: string;
  readonly userId: string;
  readonly brandId: string;
}

const announcement = (status: string): Announcement => ({
  room: brandRoom(BRAND),
  userId: LINA,
  brandId: BRAND,
  status,
});

describe('PresenceService', () => {
  let redis: RedisStub;
  let store: PresenceStore;
  let publisher: RealtimePublisher;
  let announced: Announcement[];
  let offline: StaffOfflineHook & { calls: [string, string, Date][] };
  let service: PresenceService;

  beforeEach(() => {
    redis = new RedisStub();
    store = new PresenceStore(redis.asRedis());
    announced = [];
    publisher = new RealtimePublisher();
    // A namespace is the one thing the publisher needs and the one thing a unit
    // test has no business booting.
    publisher.bind({
      to: (room: string) => ({
        emit: (event: string, envelope: { data: Omit<Announcement, 'room'> }) => {
          expect(event).toBe(REALTIME_EVENTS.presenceChanged);
          announced.push({ room, ...envelope.data });
        },
      }),
      // biome-ignore lint/suspicious/noExplicitAny: the double implements the one method the publisher calls.
    } as any);

    offline = {
      calls: [],
      onStaffOffline(userId: string, brandId: string, since: Date) {
        this.calls.push([userId, brandId, since]);
      },
    };

    service = new PresenceService(store, publisher, offline, silentLogger());
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('tells a listener of every change in a brand, until it unsubscribes (M4-04)', async () => {
    const heard: string[] = [];
    const stop = service.onChange((brandId) => heard.push(brandId));

    await service.join({ brandId: BRAND, userId: LINA, socketId: 's1' });
    stop();
    await service.leave({ brandId: BRAND, userId: LINA, socketId: 's1' });

    expect(heard).toEqual([BRAND]);
  });

  it('announces an arrival to the brand room, once per person', async () => {
    expect(await service.join({ brandId: BRAND, userId: LINA, socketId: 's1' })).toBe('online');
    await service.join({ brandId: BRAND, userId: LINA, socketId: 's2' });

    expect(announced).toEqual([announcement('online')]);
  });

  it('announces a departure only when the last socket goes, and calls the M1 hook', async () => {
    await service.join({ brandId: BRAND, userId: LINA, socketId: 's1' });
    await service.join({ brandId: BRAND, userId: LINA, socketId: 's2' });
    announced.length = 0;

    await service.leave({ brandId: BRAND, userId: LINA, socketId: 's1' });
    expect(announced).toEqual([]);
    expect(offline.calls).toEqual([]);

    await service.leave({ brandId: BRAND, userId: LINA, socketId: 's2' });
    expect(announced).toEqual([announcement('offline')]);
    // The third argument is where M1-07's fifteen-minute timer starts.
    expect(offline.calls).toEqual([[LINA, BRAND, expect.any(Date)]]);
  });

  it('announces the explicit toggle', async () => {
    await service.join({ brandId: BRAND, userId: LINA, socketId: 's1' });
    announced.length = 0;

    expect(await service.setStatus({ brandId: BRAND, userId: LINA }, 'away')).toBe('away');
    expect(announced).toEqual([announcement('away')]);
  });

  it('announces nothing when someone who is not connected sets a status', async () => {
    expect(await service.setStatus({ brandId: BRAND, userId: LINA }, 'away')).toBe('offline');
    expect(announced).toEqual([]);
  });

  it('keeps an away person away when a second tab of theirs connects', async () => {
    await service.join({ brandId: BRAND, userId: LINA, socketId: 's1' });
    await service.setStatus({ brandId: BRAND, userId: LINA }, 'away');

    expect(await service.join({ brandId: BRAND, userId: LINA, socketId: 's2' })).toBe('away');
    expect(await service.mapOf(BRAND)).toEqual({ [LINA]: 'away' });
  });

  describe('the reaper', () => {
    it('takes someone offline once their liveness key has expired', async () => {
      await service.join({ brandId: BRAND, userId: LINA, socketId: 's1' });
      announced.length = 0;
      await redis.del(presenceSocketKey('s1'));

      await service.sweep();

      expect(announced).toEqual([announcement('offline')]);
      expect(offline.calls).toEqual([[LINA, BRAND, expect.any(Date)]]);
    });

    it('runs on its own, without anything asking it to', async () => {
      vi.useFakeTimers();
      await service.join({ brandId: BRAND, userId: LINA, socketId: 's1' });
      announced.length = 0;
      await redis.del(presenceSocketKey('s1'));

      service.onModuleInit();
      await vi.advanceTimersByTimeAsync(PRESENCE_REAPER_INTERVAL_MS);

      expect(announced).toEqual([announcement('offline')]);
    });

    it('survives Redis being unreachable, because the next sweep is thirty seconds away', async () => {
      const logger = silentLogger();
      const error = vi.spyOn(logger, 'error');
      const broken = {
        brands: () => Promise.reject(new Error('redis is down')),
      } as unknown as PresenceStore;

      await new PresenceService(broken, publisher, offline, logger).sweep();

      expect(error).toHaveBeenCalledOnce();
    });

    it('does not let the M1 hook failing stop the announcement', async () => {
      const logger = silentLogger();
      const error = vi.spyOn(logger, 'error');
      const throwing = new PresenceService(
        store,
        publisher,
        {
          onStaffOffline: () => {
            throw new Error('M1 blew up');
          },
        },
        logger,
      );

      await throwing.join({ brandId: BRAND, userId: LINA, socketId: 's1' });
      announced.length = 0;
      await throwing.leave({ brandId: BRAND, userId: LINA, socketId: 's1' });

      expect(announced).toEqual([announcement('offline')]);
      expect(error).toHaveBeenCalledOnce();
    });
  });

  describe('heartbeats', () => {
    it('re-announces someone a sweep dropped a moment too early', async () => {
      await service.join({ brandId: BRAND, userId: LINA, socketId: 's1' });
      await redis.del(presenceSocketKey('s1'));
      await service.sweep();
      announced.length = 0;

      await service.heartbeat('s1', [{ brandId: BRAND, userId: LINA, socketId: 's1' }]);

      expect(announced).toEqual([announcement('online')]);
    });

    it('announces nothing in the ordinary case', async () => {
      await service.join({ brandId: BRAND, userId: LINA, socketId: 's1' });
      announced.length = 0;

      await service.heartbeat('s1', [{ brandId: BRAND, userId: LINA, socketId: 's1' }]);

      expect(announced).toEqual([]);
    });
  });

  describe('idle away (M14-18)', () => {
    const MINUTE = 60_000;
    let clock: number;
    let limits: Map<string, number>;
    let idleService: PresenceService;
    let limitsFor: IdleAwayPolicy['limitsFor'];

    beforeEach(() => {
      clock = 10_000_000;
      limits = new Map([[LINA, 30]]);
      limitsFor = () => Promise.resolve(limits);
      store = new PresenceStore(redis.asRedis(), () => clock);
      idleService = new PresenceService(store, publisher, offline, silentLogger(), {
        limitsFor: (brandId) => limitsFor(brandId),
      });
    });

    const joinLina = (): Promise<unknown> =>
      idleService.join({ brandId: BRAND, userId: LINA, socketId: 's1' });

    it('marks someone away when their limit has passed, and announces it once', async () => {
      await joinLina();
      announced.length = 0;

      await idleService.sweep(clock + 30 * MINUTE);
      await idleService.sweep(clock + 31 * MINUTE);

      expect(announced).toEqual([announcement('away')]);
      expect(await idleService.mapOf(BRAND)).toEqual({ [LINA]: 'away' });
    });

    it('leaves them online one millisecond before the limit', async () => {
      await joinLina();
      announced.length = 0;

      await idleService.sweep(clock + 30 * MINUTE - 1);

      expect(announced).toEqual([]);
      expect(await idleService.mapOf(BRAND)).toEqual({ [LINA]: 'online' });
    });

    it('restarts the count whenever they report activity', async () => {
      await joinLina();
      clock += 20 * MINUTE;
      await idleService.active({ brandId: BRAND, userId: LINA });
      announced.length = 0;

      await idleService.sweep(clock + 29 * MINUTE);
      expect(announced).toEqual([]);

      await idleService.sweep(clock + 30 * MINUTE);
      expect(announced).toEqual([announcement('away')]);
    });

    it('never marks someone whose departments set no limit', async () => {
      limits.clear();
      await joinLina();
      announced.length = 0;

      await idleService.sweep(clock + 24 * 60 * MINUTE);

      expect(announced).toEqual([]);
    });

    it('uses each person limit, not the shortest in the brand', async () => {
      const omar = '01937f5e-7e53-7000-8000-000000000002';
      limits = new Map([
        [LINA, 10],
        [omar, 60],
      ]);
      await joinLina();
      await idleService.join({ brandId: BRAND, userId: omar, socketId: 's2' });

      await idleService.sweep(clock + 11 * MINUTE);

      expect(await idleService.mapOf(BRAND)).toEqual({ [LINA]: 'away', [omar]: 'online' });
    });

    it('starts the clock for someone present before they had one', async () => {
      await joinLina();
      await redis.hdel(presenceActiveKey(BRAND), LINA);
      announced.length = 0;

      await idleService.sweep(clock + 40 * MINUTE);
      expect(announced).toEqual([]);

      clock += 40 * MINUTE;
      await idleService.sweep(clock + 30 * MINUTE);
      expect(announced).toEqual([announcement('away')]);
    });

    it('brings them back on activity, announces it, and says the idle away ended', async () => {
      await joinLina();
      await idleService.sweep(clock + 30 * MINUTE);
      announced.length = 0;

      expect(await idleService.active({ brandId: BRAND, userId: LINA })).toEqual({
        status: 'online',
        idleEnded: true,
      });
      expect(announced).toEqual([announcement('online')]);

      expect(await idleService.active({ brandId: BRAND, userId: LINA })).toEqual({
        status: 'online',
        idleEnded: false,
      });
      expect(announced).toEqual([announcement('online')]);
    });

    it('does not claim a return for someone who chose away themselves', async () => {
      await joinLina();
      await idleService.setStatus({ brandId: BRAND, userId: LINA }, 'away');
      await idleService.sweep(clock + 30 * MINUTE);
      announced.length = 0;

      expect(await idleService.active({ brandId: BRAND, userId: LINA })).toEqual({
        status: 'away',
        idleEnded: false,
      });
      expect(announced).toEqual([announcement('away')]);
    });

    it('answers offline to activity from someone with no socket', async () => {
      expect(await idleService.active({ brandId: BRAND, userId: LINA })).toEqual({
        status: 'offline',
        idleEnded: false,
      });
      expect(announced).toEqual([]);
    });

    it('lifts the mark when the department stops asking for it', async () => {
      await joinLina();
      await idleService.sweep(clock + 30 * MINUTE);
      announced.length = 0;
      limits.clear();

      await idleService.sweep(clock + 31 * MINUTE);

      expect(announced).toEqual([announcement('online')]);
      expect(await idleService.mapOf(BRAND)).toEqual({ [LINA]: 'online' });
    });

    it('keeps every mark as it was when the limits cannot be read', async () => {
      await joinLina();
      await idleService.sweep(clock + 30 * MINUTE);
      announced.length = 0;
      limitsFor = () => Promise.reject(new Error('postgres is down'));

      await idleService.sweep(clock + 31 * MINUTE);

      expect(announced).toEqual([]);
      expect(await idleService.mapOf(BRAND)).toEqual({ [LINA]: 'away' });
    });

    it('tells the widget listeners when someone goes idle, as for any presence change', async () => {
      const heard: string[] = [];
      idleService.onChange((brandId) => heard.push(brandId));
      await joinLina();
      heard.length = 0;

      await idleService.sweep(clock + 30 * MINUTE);

      expect(heard).toEqual([BRAND]);
    });

    it('does not start the offline timer for an idle person: away is not offline', async () => {
      await joinLina();
      await idleService.sweep(clock + 30 * MINUTE);

      expect(offline.calls).toEqual([]);
    });
  });
});
