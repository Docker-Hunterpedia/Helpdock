import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { holdRecipientPace, paceKey, RecipientPaceHeld, withRecipientPace } from './meta-pacing.js';

/** The two commands the pacing uses, over a map and a clock the test moves. */
const fakeRedis = () => {
  const clock = { now: 1_000_000 };
  const expiry = new Map<string, number>();
  const live = (key: string): boolean => (expiry.get(key) ?? 0) > clock.now;
  const redis = {
    set: async (key: string, _value: string, _px: 'PX', ms: number, nx?: 'NX') => {
      if (nx === 'NX' && live(key)) {
        return null;
      }
      expiry.set(key, clock.now + ms);
      return 'OK';
    },
    pttl: async (key: string) =>
      expiry.has(key) ? (live(key) ? (expiry.get(key) ?? 0) - clock.now : -2) : -2,
  } as unknown as Redis;

  return { clock, expiry, redis };
};

const key = paceKey('account-1', '16505551234');

describe('paceKey', () => {
  it('is one key per account and customer', () => {
    expect(key).toBe('meta.pace:account-1:16505551234');
    expect(paceKey('account-2', '16505551234')).not.toBe(key);
  });
});

describe('withRecipientPace', () => {
  it('sends when the slot is free and returns what the send returned', async () => {
    const { redis } = fakeRedis();

    expect(await withRecipientPace(redis, key, async () => 'wamid.1')).toBe('wamid.1');
  });

  it('holds the slot for a whole pace from the end of the send', async () => {
    const { clock, expiry, redis } = fakeRedis();

    await withRecipientPace(redis, key, async () => {
      clock.now += 700;
    });

    expect(expiry.get(key)).toBe(clock.now + 6_000);
  });

  it('does not send while the slot is held, and says how long is left', async () => {
    const { clock, redis } = fakeRedis();
    await withRecipientPace(redis, key, async () => undefined);
    clock.now += 2_500;
    let sent = false;

    const held = await withRecipientPace(redis, key, async () => {
      sent = true;
    }).catch((error: unknown) => error);

    expect(sent).toBe(false);
    expect(held).toBeInstanceOf(RecipientPaceHeld);
    // 3.5 s of the pace are left, and a little slack so the retry lands after it.
    expect((held as RecipientPaceHeld).remainingMs).toBe(3_500 + 50);
  });

  it('sends again once a whole pace has passed', async () => {
    const { clock, redis } = fakeRedis();
    await withRecipientPace(redis, key, async () => undefined);
    clock.now += 6_000;

    await expect(withRecipientPace(redis, key, async () => 'second')).resolves.toBe('second');
  });

  it('keeps one customer’s pace from holding another’s', async () => {
    const { redis } = fakeRedis();
    await withRecipientPace(redis, key, async () => undefined);

    await expect(
      withRecipientPace(redis, paceKey('account-1', '16505559999'), async () => 'other'),
    ).resolves.toBe('other');
  });

  it('keeps the claim when the send fails, so a retry waits out the rest of the pace', async () => {
    const { redis } = fakeRedis();

    await expect(
      withRecipientPace(redis, key, async () => {
        throw new Error('graph is down');
      }),
    ).rejects.toThrow('graph is down');

    await expect(withRecipientPace(redis, key, async () => 'retry')).rejects.toBeInstanceOf(
      RecipientPaceHeld,
    );
  });

  it('waits only the slack when the key went between the claim and the read', async () => {
    const racing = {
      set: async () => null,
      pttl: async () => -2,
    } as unknown as Redis;

    const held = await withRecipientPace(racing, key, async () => 'x').catch(
      (error: unknown) => error,
    );

    expect((held as RecipientPaceHeld).remainingMs).toBe(50);
  });

  it('waits a whole pace for a key that somehow has no expiry', async () => {
    const racing = {
      set: async () => null,
      pttl: async () => -1,
    } as unknown as Redis;

    const held = await withRecipientPace(racing, key, async () => 'x').catch(
      (error: unknown) => error,
    );

    expect((held as RecipientPaceHeld).remainingMs).toBe(6_050);
  });
});

describe('holdRecipientPace', () => {
  it('makes the next part wait a pace, as when Meta itself said 131056', async () => {
    const { clock, redis } = fakeRedis();

    await holdRecipientPace(redis, key);
    clock.now += 1_000;

    const held = await withRecipientPace(redis, key, async () => 'x').catch(
      (error: unknown) => error,
    );
    expect((held as RecipientPaceHeld).remainingMs).toBe(5_000 + 50);
  });
});
