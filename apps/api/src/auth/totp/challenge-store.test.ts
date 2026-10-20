import { uuidv7 } from '@helpdock/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authRedis } from '../../testing/auth-redis.js';
import type { RedisStub } from '../../testing/redis-stub.js';
import { totpChallengeKey, totpFailuresKey, totpLockKey } from '../redis-keys.js';
import {
  TOTP_CHALLENGE_TTL_SECONDS,
  TOTP_LOCK_SECONDS,
  TOTP_MAX_ATTEMPTS,
  type TotpChallenge,
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

/** One wrong code, the way the service takes it: reserve, evaluate, fail. */
const wrongCode = async (challengeId: string, challenge: TotpChallenge) => {
  const reserved = await store.reserveAttempt(challengeId, challenge);
  if (reserved.status !== 'reserved') return reserved;
  return store.failAttempt(challengeId, challenge, reserved.attemptsLeft);
};

const open = async (challengeId = ''): Promise<{ id: string; challenge: TotpChallenge }> => {
  const id = challengeId === '' ? await start() : challengeId;
  const found = await store.read(id);
  if (found.status !== 'ok') throw new Error('expected an open challenge');
  return { id, challenge: found.challenge };
};

describe('reserveAttempt and failAttempt', () => {
  it('counts down and then locks, which is what the screen renders', async () => {
    const { id, challenge } = await open();
    const outcomes: unknown[] = [];

    for (let attempt = 0; attempt < TOTP_MAX_ATTEMPTS; attempt += 1) {
      outcomes.push(await wrongCode(id, challenge));
    }

    expect(outcomes).toEqual([
      { status: 'remaining', attemptsLeft: 2 },
      { status: 'remaining', attemptsLeft: 1 },
      { status: 'locked' },
    ]);
  });

  it('deletes the challenge and locks the account on the last attempt', async () => {
    const { id, challenge } = await open();

    for (let attempt = 0; attempt < TOTP_MAX_ATTEMPTS; attempt += 1) {
      await wrongCode(id, challenge);
    }

    await expect(stub.get(totpChallengeKey(id))).resolves.toBeNull();
    await expect(store.isLocked(USER_ID)).resolves.toBe(true);
    expect(stub.ttlOf(totpLockKey(USER_ID))).toBe(TOTP_LOCK_SECONDS);
  });

  it('lets the third reservation evaluate, so a correct third code still signs in', async () => {
    const { id, challenge } = await open();
    await wrongCode(id, challenge);
    await wrongCode(id, challenge);

    await expect(store.reserveAttempt(id, challenge)).resolves.toEqual({
      status: 'reserved',
      attemptsLeft: 0,
    });
    await expect(store.consume(id, USER_ID)).resolves.toBe('spent');
  });

  it('refuses a fourth reservation unevaluated, and locks', async () => {
    const { id, challenge } = await open();
    for (let attempt = 0; attempt < TOTP_MAX_ATTEMPTS; attempt += 1) {
      await store.reserveAttempt(id, challenge);
    }

    await expect(store.reserveAttempt(id, challenge)).resolves.toEqual({ status: 'locked' });
    await expect(store.isLocked(USER_ID)).resolves.toBe(true);
    await expect(store.consume(id, USER_ID)).resolves.toBe('expired');
  });

  it('trusts the stored count, not the copy the caller read', async () => {
    const { id, challenge } = await open();

    await store.reserveAttempt(id, challenge);
    await expect(store.reserveAttempt(id, challenge)).resolves.toEqual({
      status: 'reserved',
      attemptsLeft: 1,
    });
  });

  it('counts wrong values across challenges and locks at the limit', async () => {
    const outcomes: unknown[] = [];
    for (let round = 0; round < TOTP_MAX_ATTEMPTS; round += 1) {
      const { id, challenge } = await open();
      outcomes.push(await wrongCode(id, challenge));
    }

    expect(outcomes).toEqual([
      { status: 'remaining', attemptsLeft: 2 },
      { status: 'remaining', attemptsLeft: 1 },
      { status: 'locked' },
    ]);
    await expect(store.isLocked(USER_ID)).resolves.toBe(true);
    await expect(stub.get(totpFailuresKey(USER_ID))).resolves.toBeNull();
  });

  it('slides the counter window from the last failure, so spaced failures still accumulate', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const first = await open();
      await wrongCode(first.id, first.challenge);
      vi.setSystemTime(1_000_000 + (TOTP_LOCK_SECONDS - 60) * 1000);
      const second = await open();
      await wrongCode(second.id, second.challenge);
      expect(stub.ttlOf(totpFailuresKey(USER_ID))).toBe(TOTP_LOCK_SECONDS);

      // The first failure is now older than the window; the counter still stands.
      vi.setSystemTime(1_000_000 + (TOTP_LOCK_SECONDS + 30) * 1000);
      const third = await open();
      await expect(wrongCode(third.id, third.challenge)).resolves.toEqual({ status: 'locked' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a reservation on a locked account and removes its challenge', async () => {
    const { id, challenge } = await open();
    await stub.set(totpLockKey(USER_ID), '1', 'EX', TOTP_LOCK_SECONDS);

    await expect(store.reserveAttempt(id, challenge)).resolves.toEqual({ status: 'locked' });
    await expect(stub.get(totpChallengeKey(id))).resolves.toBeNull();
  });

  it('forgives the counter only when told a sign-in completed', async () => {
    const { id, challenge } = await open();
    await wrongCode(id, challenge);

    await store.clearFailures(USER_ID);

    await expect(stub.get(totpFailuresKey(USER_ID))).resolves.toBeNull();
  });

  it('never recreates a consumed or expired challenge', async () => {
    const { id, challenge } = await open();
    await store.consume(id, USER_ID);

    await expect(store.reserveAttempt(id, challenge)).resolves.toEqual({ status: 'expired' });
    await expect(stub.get(totpChallengeKey(id))).resolves.toBeNull();
  });

  it('does not extend the challenge when an attempt is reserved', async () => {
    const challengeId = await start();
    await stub.expire(totpChallengeKey(challengeId), 30);
    const { challenge } = await open(challengeId);

    await store.reserveAttempt(challengeId, challenge);

    expect(stub.ttlOf(totpChallengeKey(challengeId))).toBeLessThanOrEqual(30);
  });
});

describe('consume', () => {
  it('spends the challenge, so one code opens one session', async () => {
    const challengeId = await start();

    await expect(store.consume(challengeId, USER_ID)).resolves.toBe('spent');

    await expect(store.read(challengeId)).resolves.toEqual({ status: 'expired' });
    await expect(store.consume(challengeId, USER_ID)).resolves.toBe('expired');
  });

  it('refuses when a lock landed after the code was read, and removes the challenge', async () => {
    const challengeId = await start();
    await stub.set(totpLockKey(USER_ID), '1', 'EX', TOTP_LOCK_SECONDS);

    await expect(store.consume(challengeId, USER_ID)).resolves.toBe('locked');
    await expect(stub.get(totpChallengeKey(challengeId))).resolves.toBeNull();
  });

  it('refuses another account', async () => {
    const challengeId = await start();

    await expect(store.consume(challengeId, uuidv7())).resolves.toBe('expired');
  });
});

describe('clearLock', () => {
  it('lets an account back in once it has enrolled', async () => {
    await stub.set(totpLockKey(USER_ID), '1', 'EX', TOTP_LOCK_SECONDS);

    await store.clearLock(USER_ID);

    await expect(store.isLocked(USER_ID)).resolves.toBe(false);
  });
});
