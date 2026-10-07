import { uuidv7 } from '@helpdock/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authRedis } from '../../testing/auth-redis.js';
import type { RedisStub } from '../../testing/redis-stub.js';
import { familyKey, revokedSessionKey, userFamiliesKey } from '../redis-keys.js';
import { ACCESS_TOKEN_TTL_SECONDS } from './access-token.js';
import { DEFAULT_SESSION_LIFETIME } from './lifetime.js';
import { RefreshStore, truncateUserAgent } from './refresh-store.js';

const USER_ID = uuidv7();
const OTHER_USER_ID = uuidv7();

let stub: RedisStub;
let store: RefreshStore;

beforeEach(() => {
  const created = authRedis();
  stub = created.stub;
  store = new RefreshStore(created.redis);
});

const open = () => store.createFamily({ userId: USER_ID, userAgent: 'Firefox' });

describe('createFamily', () => {
  it('stores the hash of the token and never the token', async () => {
    const { familyId, token } = await open();

    expect(await stub.hget(familyKey(familyId), 'currentHash')).not.toBe(token);
    expect(await stub.hget(familyKey(familyId), 'userId')).toBe(USER_ID);
    expect(JSON.stringify([...stub.keys()])).not.toContain(token);
  });

  it('lives as long as the idle limit and indexes the family under its user', async () => {
    const { familyId } = await open();

    expect(stub.ttlOf(familyKey(familyId))).toBe(DEFAULT_SESSION_LIFETIME.idleSeconds);
    expect(await stub.smembers(userFamiliesKey(USER_ID))).toEqual([familyId]);
  });
});

describe('the idle and absolute limits (ASVS 3.3.2)', () => {
  const HOUR = 60 * 60;
  const START = new Date('2026-10-05T08:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const created = authRedis();
    stub = created.stub;
    store = new RefreshStore(created.redis, { idleSeconds: 2 * HOUR, maxSeconds: 5 * HOUR });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const hoursIn = (hours: number): void => {
    vi.setSystemTime(new Date(START.getTime() + hours * HOUR * 1000));
  };

  it('ends a family nobody refreshed for the idle limit', async () => {
    const { familyId, token } = await open();

    hoursIn(2.5);

    await expect(store.rotate({ familyId, token, userAgent: 'Firefox' })).resolves.toEqual({
      status: 'unknown',
    });
  });

  const rotateAt = async (
    familyId: string,
    token: string,
    hours: readonly number[],
  ): Promise<string> => {
    let current = token;
    for (const hour of hours) {
      hoursIn(hour);
      const rotated = await store.rotate({ familyId, token: current, userAgent: 'Firefox' });
      if (rotated.status !== 'rotated') {
        throw new Error(`expected a rotation ${hour} hours in`);
      }
      current = rotated.token;
    }
    return current;
  };

  it('keeps a busy family going, but not past the absolute limit', async () => {
    const { familyId, token } = await open();
    const last = await rotateAt(familyId, token, [1.5, 3, 4.5]);

    hoursIn(5);

    await expect(store.rotate({ familyId, token: last, userAgent: 'Firefox' })).resolves.toEqual({
      status: 'unknown',
    });
  });

  it('renews for the idle limit, or for what is left of the absolute one when that is less', async () => {
    const { familyId, token } = await open();

    await rotateAt(familyId, token, [1]);
    expect(stub.ttlOf(familyKey(familyId))).toBe(2 * HOUR);

    hoursIn(0);
    const { familyId: second, token: secondToken } = await open();
    await rotateAt(second, secondToken, [1, 2.5, 4]);
    expect(stub.ttlOf(familyKey(second))).toBe(1 * HOUR);
  });

  it('ends a family already older than a limit an operator has since lowered', async () => {
    const { familyId, token } = await open();
    const shorter = new RefreshStore(stub.asRedis(), { idleSeconds: HOUR, maxSeconds: HOUR });

    hoursIn(1.5);

    await expect(shorter.rotate({ familyId, token, userAgent: 'Firefox' })).resolves.toEqual({
      status: 'expired',
      userId: USER_ID,
    });
    await expect(shorter.familiesOf(USER_ID)).resolves.toEqual([]);
  });
});

describe('rotate', () => {
  it('mints a new token and retires the old one', async () => {
    const { familyId, token } = await open();

    const first = await store.rotate({ familyId, token, userAgent: 'Firefox' });

    expect(first).toMatchObject({ status: 'rotated', userId: USER_ID });
    if (first.status !== 'rotated') {
      throw new Error('expected a rotation');
    }
    expect(first.token).not.toBe(token);

    await expect(
      store.rotate({ familyId, token: first.token, userAgent: 'Firefox' }),
    ).resolves.toMatchObject({ status: 'rotated' });
  });

  it('reports reuse and kills the family when a retired token comes back', async () => {
    const { familyId, token } = await open();
    await store.rotate({ familyId, token, userAgent: 'Firefox' });

    await expect(store.rotate({ familyId, token, userAgent: 'Firefox' })).resolves.toEqual({
      status: 'reused',
      userId: USER_ID,
    });

    expect(await stub.hget(familyKey(familyId), 'userId')).toBeNull();
    expect(await stub.smembers(userFamiliesKey(USER_ID))).toEqual([]);
  });

  it('marks the access tokens the stolen family issued, so the theft ends now', async () => {
    const { familyId, token } = await open();
    const sessionId = uuidv7();
    await store.registerSession(familyId, sessionId);
    await store.rotate({ familyId, token, userAgent: 'Firefox' });

    await store.rotate({ familyId, token, userAgent: 'Firefox' });

    await expect(store.isSessionRevoked(sessionId)).resolves.toBe(true);
    expect(stub.ttlOf(revokedSessionKey(sessionId))).toBe(ACCESS_TOKEN_TTL_SECONDS);
  });

  it('answers unknown for a family that never existed', async () => {
    await expect(
      store.rotate({ familyId: uuidv7(), token: 'made-up', userAgent: 'Firefox' }),
    ).resolves.toEqual({ status: 'unknown' });
  });

  it('records the browser, truncated, so Redis holds no full fingerprint', async () => {
    const { familyId, token } = await open();

    await store.rotate({ familyId, token, userAgent: 'x'.repeat(500) });

    expect((await stub.hget(familyKey(familyId), 'ua'))?.length).toBe(120);
  });
});

describe('revokeFamily', () => {
  it('ends one family and leaves the others alone', async () => {
    const one = await open();
    const two = await open();

    await expect(store.revokeFamily(one.familyId)).resolves.toBe(USER_ID);

    await expect(
      store.rotate({ familyId: one.familyId, token: one.token, userAgent: 'Firefox' }),
    ).resolves.toEqual({ status: 'unknown' });
    await expect(
      store.rotate({ familyId: two.familyId, token: two.token, userAgent: 'Firefox' }),
    ).resolves.toMatchObject({ status: 'rotated' });
  });

  it('answers null for a family that is not there', async () => {
    await expect(store.revokeFamily(uuidv7())).resolves.toBeNull();
  });
});

describe('revokeAllForUser', () => {
  it('ends every family of one user and no other user', async () => {
    const mine = await open();
    const theirs = await store.createFamily({ userId: OTHER_USER_ID, userAgent: 'Firefox' });
    await open();

    await expect(store.revokeAllForUser(USER_ID)).resolves.toBe(2);

    await expect(
      store.rotate({ familyId: mine.familyId, token: mine.token, userAgent: 'Firefox' }),
    ).resolves.toEqual({ status: 'unknown' });
    await expect(
      store.rotate({ familyId: theirs.familyId, token: theirs.token, userAgent: 'Firefox' }),
    ).resolves.toMatchObject({ status: 'rotated' });
  });
});

describe('isSessionRevoked', () => {
  it('is false for a session nobody revoked', async () => {
    await expect(store.isSessionRevoked(uuidv7())).resolves.toBe(false);
  });
});

describe('truncateUserAgent', () => {
  it('turns an absent header into an empty string rather than "undefined"', () => {
    expect(truncateUserAgent(undefined)).toBe('');
  });
});
