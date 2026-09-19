import { uuidv7 } from '@helpdock/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { authRedis } from '../../testing/auth-redis.js';
import type { RedisStub } from '../../testing/redis-stub.js';
import { totpChallengeKey, totpLockKey } from '../redis-keys.js';
import {
  TOTP_CHALLENGE_TTL_SECONDS,
  TOTP_LOCK_SECONDS,
  TOTP_MAX_ATTEMPTS,
  TotpChallengeStore,
} from './challenge-store.js';

const USER_ID = uuidv7();

let stub: RedisStub;
let store: TotpChallengeStore;

beforeEach(() => {
  const created = authRedis();
  stub = created.stub;
  store = new TotpChallengeStore(created.redis);
});

const start = () => store.create({ userId: USER_ID, kind: 'second-factor' });

describe('create', () => {
  it('names the user, not the address, so a challenge id confirms nothing', async () => {
    const challengeId = await start();

    const raw = await stub.get(totpChallengeKey(challengeId));
    expect(JSON.parse(raw ?? '{}')).toMatchObject({ userId: USER_ID, attempts: 0 });
    expect(raw).not.toContain('@');
  });

  it('expires in five minutes', async () => {
    expect(stub.ttlOf(totpChallengeKey(await start()))).toBe(TOTP_CHALLENGE_TTL_SECONDS);
  });
});

describe('read', () => {
  it('returns the challenge it stored', async () => {
    const challengeId = await start();

    await expect(store.read(challengeId)).resolves.toMatchObject({
      status: 'ok',
      challenge: { userId: USER_ID, kind: 'second-factor' },
    });
  });

  it('reports a challenge it never issued as expired', async () => {
    await expect(store.read(uuidv7())).resolves.toEqual({ status: 'expired' });
  });

  it('throws nothing away quietly when the record cannot be read', async () => {
    const challengeId = await start();
    await stub.set(totpChallengeKey(challengeId), 'not json');

    await expect(store.read(challengeId)).resolves.toEqual({ status: 'expired' });
    await expect(stub.get(totpChallengeKey(challengeId))).resolves.toBeNull();
  });

  it('reports a locked account as locked, whatever the challenge says', async () => {
    const challengeId = await start();
    await stub.set(totpLockKey(USER_ID), '1', 'EX', TOTP_LOCK_SECONDS);

    await expect(store.read(challengeId)).resolves.toEqual({ status: 'locked' });
  });
});

describe('spendAttempt', () => {
  it('counts down and then locks, which is what the screen renders', async () => {
    const challengeId = await start();
    const outcomes: unknown[] = [];

    for (let attempt = 0; attempt < TOTP_MAX_ATTEMPTS; attempt += 1) {
      const found = await store.read(challengeId);
      if (found.status !== 'ok') {
        throw new Error('expected the challenge to still be open');
      }
      outcomes.push(await store.spendAttempt(challengeId, found.challenge));
    }

    expect(outcomes).toEqual([
      { status: 'remaining', attemptsLeft: 2 },
      { status: 'remaining', attemptsLeft: 1 },
      { status: 'locked' },
    ]);
  });

  it('deletes the challenge and locks the account on the last attempt', async () => {
    const challengeId = await start();
    const found = await store.read(challengeId);
    if (found.status !== 'ok') {
      throw new Error('expected the challenge to still be open');
    }

    await store.spendAttempt(challengeId, { ...found.challenge, attempts: 2 });

    await expect(stub.get(totpChallengeKey(challengeId))).resolves.toBeNull();
    await expect(store.isLocked(USER_ID)).resolves.toBe(true);
    expect(stub.ttlOf(totpLockKey(USER_ID))).toBe(TOTP_LOCK_SECONDS);
  });

  it('does not extend the challenge when an attempt is spent', async () => {
    const challengeId = await start();
    await stub.expire(totpChallengeKey(challengeId), 30);
    const found = await store.read(challengeId);
    if (found.status !== 'ok') {
      throw new Error('expected the challenge to still be open');
    }

    await store.spendAttempt(challengeId, found.challenge);

    expect(stub.ttlOf(totpChallengeKey(challengeId))).toBeLessThanOrEqual(30);
  });
});

describe('consume', () => {
  it('spends the challenge, so one code opens one session', async () => {
    const challengeId = await start();

    await store.consume(challengeId);

    await expect(store.read(challengeId)).resolves.toEqual({ status: 'expired' });
  });
});

describe('clearLock', () => {
  it('lets an account back in once it has enrolled', async () => {
    await stub.set(totpLockKey(USER_ID), '1', 'EX', TOTP_LOCK_SECONDS);

    await store.clearLock(USER_ID);

    await expect(store.isLocked(USER_ID)).resolves.toBe(false);
  });
});
