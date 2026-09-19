import { randomBytes } from 'node:crypto';
import { uuidv7 } from '@helpdock/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { authRedis } from '../../testing/auth-redis.js';
import type { RedisStub } from '../../testing/redis-stub.js';
import { TRUSTED_DEVICE_TTL_SECONDS } from '../session/cookies.js';
import { deriveTrustedDeviceKey, TrustedDeviceStore } from './trusted-device.js';

const MASTER_KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const USER_ID = uuidv7();
const OTHER_USER_ID = uuidv7();

let stub: RedisStub;
let store: TrustedDeviceStore;

beforeEach(() => {
  const created = authRedis();
  stub = created.stub;
  store = new TrustedDeviceStore({ redis: created.redis, masterKey: MASTER_KEY });
});

describe('deriveTrustedDeviceKey', () => {
  it('is not the password pepper, so one key does not sign two things', async () => {
    const { derivePepper } = await import('../password.js');

    expect(deriveTrustedDeviceKey(MASTER_KEY).equals(derivePepper(MASTER_KEY))).toBe(false);
  });
});

describe('TrustedDeviceStore', () => {
  it('trusts a browser it minted a cookie for', async () => {
    const cookie = await store.trust(USER_ID);

    await expect(store.isTrusted(USER_ID, cookie)).resolves.toBe(true);
  });

  it('remembers it for thirty days, the same as the session', async () => {
    await store.trust(USER_ID);
    const [key] = stub.keys();

    expect(stub.ttlOf(key ?? '')).toBe(TRUSTED_DEVICE_TTL_SECONDS);
  });

  it('refuses a cookie minted for another account', async () => {
    const cookie = await store.trust(OTHER_USER_ID);

    await expect(store.isTrusted(USER_ID, cookie)).resolves.toBe(false);
  });

  it('refuses a cookie whose user id was swapped for this one', async () => {
    const cookie = await store.trust(OTHER_USER_ID);
    const [, nonce, mac] = cookie.split('.');

    await expect(store.isTrusted(USER_ID, `${USER_ID}.${nonce}.${mac}`)).resolves.toBe(false);
  });

  it('refuses a cookie whose signature was tampered with', async () => {
    const cookie = await store.trust(USER_ID);
    const [userId, nonce] = cookie.split('.');

    await expect(store.isTrusted(USER_ID, `${userId}.${nonce}.forged`)).resolves.toBe(false);
  });

  it('refuses a cookie signed under a different master key', async () => {
    const other = new TrustedDeviceStore({ redis: stub.asRedis(), masterKey: OTHER_KEY });
    const cookie = await other.trust(USER_ID);

    await expect(store.isTrusted(USER_ID, cookie)).resolves.toBe(false);
  });

  it('refuses a correctly signed cookie whose record has been revoked', async () => {
    const cookie = await store.trust(USER_ID);

    await store.revokeAll(USER_ID);

    await expect(store.isTrusted(USER_ID, cookie)).resolves.toBe(false);
  });

  it.each([undefined, '', 'nonsense', 'a.b', 'a.b.c.d'])('refuses %o', async (cookie) => {
    await expect(store.isTrusted(USER_ID, cookie)).resolves.toBe(false);
  });

  it('forgets only this account when everything is revoked', async () => {
    const mine = await store.trust(USER_ID);
    const theirs = await store.trust(OTHER_USER_ID);

    await store.revokeAll(USER_ID);

    await expect(store.isTrusted(USER_ID, mine)).resolves.toBe(false);
    await expect(store.isTrusted(OTHER_USER_ID, theirs)).resolves.toBe(true);
  });

  it('stores the nonce hashed, so reading Redis does not produce a cookie', async () => {
    const cookie = await store.trust(USER_ID);
    const [, nonce] = cookie.split('.');

    expect(stub.keys().join(' ')).not.toContain(nonce ?? 'nonce');
  });
});
