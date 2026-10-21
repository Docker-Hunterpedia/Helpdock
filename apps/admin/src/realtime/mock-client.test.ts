import type { PresenceChanged } from '@helpdock/schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOCK_USER, MockAuthApi } from '../auth/mock-api.js';
import type { RealtimeConnection } from './client.js';
import { MOCK_COLLEAGUE_ID, MOCK_IDLE_AWAY_MS, MockRealtimeClient } from './mock-client.js';
import { createRealtimeClient } from './select-client.js';
import { SocketRealtimeClient } from './socket-client.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';

describe('MockRealtimeClient', () => {
  const listening = () => {
    const client = new MockRealtimeClient();
    const states: RealtimeConnection[] = [];
    const changes: PresenceChanged[] = [];
    client.subscribe({
      connection: (state) => states.push(state),
      presenceChanged: (change) => changes.push(change),
    });

    return { client, states, changes };
  };

  it('comes online on start and announces it', () => {
    const { client, states, changes } = listening();

    client.start(BRAND);

    expect(states).toEqual(['connected']);
    expect(changes).toEqual([{ userId: MOCK_USER.id, brandId: BRAND, status: 'online' }]);
  });

  it('announces the toggle, so the shell exercises the state it will in production', async () => {
    const { client, changes } = listening();
    client.start(BRAND);

    await client.setPresence('away');

    expect(changes.at(-1)).toEqual({ userId: MOCK_USER.id, brandId: BRAND, status: 'away' });
    expect(await client.presence(BRAND)).toEqual({
      [MOCK_USER.id]: 'away',
      [MOCK_COLLEAGUE_ID]: 'away',
    });
  });

  describe("the fixture server's idle clock (M14-18)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('marks the person away after the limit without a report, and announces it', async () => {
      vi.useFakeTimers();
      const { client, changes } = listening();
      client.start(BRAND);

      vi.advanceTimersByTime(MOCK_IDLE_AWAY_MS - 1);
      expect(changes.at(-1)?.status).toBe('online');
      vi.advanceTimersByTime(1);

      expect(changes.at(-1)).toEqual({ userId: MOCK_USER.id, brandId: BRAND, status: 'away' });
      expect((await client.presence(BRAND))[MOCK_USER.id]).toBe('away');
    });

    it('restarts the clock on a report, and says the idle away ended once', async () => {
      vi.useFakeTimers();
      const { client, changes } = listening();
      client.start(BRAND);

      vi.advanceTimersByTime(MOCK_IDLE_AWAY_MS - 1);
      expect(await client.reportActivity()).toEqual({ status: 'online', idleEnded: false });
      vi.advanceTimersByTime(MOCK_IDLE_AWAY_MS - 1);
      expect(changes.at(-1)?.status).toBe('online');

      vi.advanceTimersByTime(1);
      expect(changes.at(-1)?.status).toBe('away');
      expect(await client.reportActivity()).toEqual({ status: 'online', idleEnded: true });
      expect(changes.at(-1)?.status).toBe('online');
      expect(await client.reportActivity()).toEqual({ status: 'online', idleEnded: false });
      expect(client.reports).toBe(3);
    });

    it('keeps a chosen away through activity, and does not call it a return', async () => {
      const { client } = listening();
      client.start(BRAND);
      await client.setPresence('away');

      expect(await client.reportActivity()).toEqual({ status: 'away', idleEnded: false });
    });

    it('ends an idle away when the person says online themselves', async () => {
      vi.useFakeTimers();
      const { client, changes } = listening();
      client.start(BRAND);
      vi.advanceTimersByTime(MOCK_IDLE_AWAY_MS);

      await client.setPresence('online');

      expect(changes.at(-1)?.status).toBe('online');
    });

    it('answers null with nothing to report over, and stops the clock on stop', async () => {
      vi.useFakeTimers();
      const { client, changes } = listening();
      expect(await client.reportActivity()).toBeNull();

      client.start(BRAND);
      client.stop();
      changes.length = 0;
      vi.advanceTimersByTime(MOCK_IDLE_AWAY_MS * 2);

      expect(changes).toEqual([]);
    });
  });

  it('goes offline on stop and leaves the colleague behind', async () => {
    const { client, states, changes } = listening();
    client.start(BRAND);

    client.stop();

    expect(states.at(-1)).toBe('closed');
    expect(changes.at(-1)).toEqual({ userId: MOCK_USER.id, brandId: BRAND, status: 'offline' });
    expect(await client.presence(BRAND)).toEqual({ [MOCK_COLLEAGUE_ID]: 'away' });
  });

  it('stops without announcing anything when it was never started', () => {
    const { client, changes } = listening();

    client.stop();

    expect(changes).toEqual([]);
  });

  it('drops a listener that has unsubscribed', () => {
    const client = new MockRealtimeClient();
    const changes: PresenceChanged[] = [];
    const unsubscribe = client.subscribe({ presenceChanged: (change) => changes.push(change) });

    unsubscribe();
    client.start(BRAND);

    expect(changes).toEqual([]);
  });
});

describe('createRealtimeClient', () => {
  it('follows the auth adapter, because a socket carries the token that adapter holds', () => {
    const api = new MockAuthApi();

    expect(createRealtimeClient(api, 'http')).toBeInstanceOf(SocketRealtimeClient);
    expect(createRealtimeClient(api, 'mock')).toBeInstanceOf(MockRealtimeClient);
  });

  it('defaults to the fixture outside a production build, as the auth adapter does', () => {
    expect(createRealtimeClient(new MockAuthApi())).toBeInstanceOf(MockRealtimeClient);
  });
});

describe('MockRealtimeClient, collision (M1-09)', () => {
  it('records what each announcement said, and has its colleague only ever viewing', () => {
    const client = new MockRealtimeClient();
    const heard: string[] = [];
    client.subscribe({ ticketViewing: (viewing) => heard.push(viewing.activity) });
    client.start(BRAND);

    client.announceViewing('0192c3f0-1a2b-7c3d-8e4f-000000001042', 'replying');

    expect(client.announcedActivity).toEqual(['replying']);
    expect(heard).toEqual(['viewing']);
  });
});
