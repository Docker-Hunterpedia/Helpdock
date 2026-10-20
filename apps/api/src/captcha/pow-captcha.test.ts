import { createHash } from 'node:crypto';
import type { PowChallenge } from '@helpdock/channels';
import { createKeyring } from '@helpdock/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedisStub } from '../testing/redis-stub.js';
import { PowCaptcha, powSpentKey } from './pow-captcha.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';
const OTHER_BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b2';
const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') });

/** The browser's half: the number, then the ALTCHA solution. */
const solve = (work: PowChallenge): string => {
  let number = 0;
  while (
    createHash('sha256')
      .update(`${work.salt}${String(number)}`)
      .digest('hex') !== work.challenge
  ) {
    number += 1;
  }
  return Buffer.from(JSON.stringify({ ...work, number })).toString('base64');
};

const setup = () => {
  const stub = new RedisStub();
  return { stub, pow: new PowCaptcha(keyring, stub.asRedis()) };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('PowCaptcha (ADR 0052)', () => {
  it('spends a solution once, and keeps the spend only as long as the challenge lives', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 20, 12) });
    const { stub, pow } = setup();
    const work = pow.issue(BRAND, 'low', 'widget-first-message');
    const token = solve(work);

    await expect(pow.spend(BRAND, token, 'widget-first-message')).resolves.toEqual({
      success: true,
    });
    await expect(pow.spend(BRAND, token, 'widget-first-message')).resolves.toEqual({
      success: false,
      errorCodes: ['already-spent'],
    });
    expect(stub.keys()).toEqual([powSpentKey(work.challenge)]);

    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(stub.keys()).toEqual([]);
  });

  it('refuses another brand’s challenge, since each brand signs under its own key', async () => {
    const { pow } = setup();
    const token = solve(pow.issue(OTHER_BRAND, 'low', 'web-form'));

    await expect(pow.spend(BRAND, token, 'web-form')).resolves.toEqual({
      success: false,
      errorCodes: ['invalid-input-response'],
    });
  });

  it('spends nothing for a refused solution', async () => {
    const { stub, pow } = setup();
    const token = solve(pow.issue(BRAND, 'low', 'web-form'));

    await pow.spend(BRAND, token, 'widget-first-message');

    expect(stub.keys()).toEqual([]);
  });
});
