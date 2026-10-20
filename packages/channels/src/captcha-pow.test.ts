import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createPowChallenge,
  POW_MAX_NUMBER,
  POW_TTL_SECONDS,
  type PowChallenge,
  verifyPowSolution,
} from './captcha-pow.js';

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 8);
const NOW = Date.UTC(2026, 9, 20, 12);

/** What the browser does: try every number until the hash matches. */
const solve = (challenge: PowChallenge): number => {
  for (let n = 0; n <= challenge.maxnumber; n += 1) {
    const hash = createHash('sha256')
      .update(`${challenge.salt}${String(n)}`)
      .digest('hex');
    if (hash === challenge.challenge) {
      return n;
    }
  }
  throw new Error('no solution');
};

const tokenOf = (challenge: PowChallenge, overrides: Record<string, unknown> = {}): string =>
  Buffer.from(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      number: solve(challenge),
      salt: challenge.salt,
      signature: challenge.signature,
      ...overrides,
    }),
  ).toString('base64');

const issued = createPowChallenge({ key: KEY, difficulty: 'low', surface: 'web-form', now: NOW });

describe('the proof-of-work challenge (ADR 0052)', () => {
  it('signs an ALTCHA-shaped challenge whose salt names its expiry and surface', () => {
    expect(issued).toMatchObject({ algorithm: 'SHA-256', maxnumber: POW_MAX_NUMBER.low });
    expect(issued.salt).toMatch(
      new RegExp(
        `^[0-9a-f]{24}\\?expires=${String(NOW / 1000 + POW_TTL_SECONDS)}&surface=web-form&$`,
      ),
    );
    expect(
      createPowChallenge({ key: KEY, difficulty: 'medium', surface: 'web-form' }).maxnumber,
    ).toBe(POW_MAX_NUMBER.medium);
  });

  it('accepts a solution and says how long it stays spendable', () => {
    expect(
      verifyPowSolution({ key: KEY, token: tokenOf(issued), surface: 'web-form', now: NOW + 1000 }),
    ).toEqual({
      success: true,
      challenge: issued.challenge,
      remainingMs: POW_TTL_SECONDS * 1000 - 1000,
    });
  });

  it.each([
    ['signed under another key', { key: OTHER_KEY }, 'invalid-input-response'],
    ['once it has expired', { now: NOW + POW_TTL_SECONDS * 1000 }, 'timeout-or-duplicate'],
    ['for the other surface', { surface: 'widget-first-message' as const }, 'action-mismatch'],
  ])('refuses a solution %s', (_label, change, code) => {
    expect(
      verifyPowSolution({
        key: KEY,
        token: tokenOf(issued),
        surface: 'web-form',
        now: NOW,
        ...change,
      }),
    ).toEqual({ success: false, errorCodes: [code] });
  });

  it('refuses digits moved from the number onto the end of the salt', () => {
    // The same bytes hash the same, so only the closed salt tells these apart:
    // `…&surface=web-form&` + `4217` against `…&surface=web-form&4` + `217`.
    let work = issued;
    while (String(solve(work)).length < 2 || String(solve(work))[1] === '0') {
      work = createPowChallenge({ key: KEY, difficulty: 'low', surface: 'web-form', now: NOW });
    }
    const digits = String(solve(work));
    const spliced = tokenOf(work, {
      salt: `${work.salt}${digits.slice(0, 1)}`,
      number: Number(digits.slice(1)),
    });

    expect(
      verifyPowSolution({ key: KEY, token: tokenOf(work), surface: 'web-form', now: NOW }).success,
    ).toBe(true);
    expect(verifyPowSolution({ key: KEY, token: spliced, surface: 'web-form', now: NOW })).toEqual({
      success: false,
      errorCodes: ['invalid-input-response'],
    });
  });

  it.each([
    ['a wrong number', (c: PowChallenge) => tokenOf(c, { number: solve(c) + 1 })],
    [
      'a later expiry',
      (c: PowChallenge) =>
        tokenOf(c, { salt: c.salt.replace(/expires=\d+/, 'expires=9999999999') }),
    ],
    ['a forged signature', (c: PowChallenge) => tokenOf(c, { signature: 'a'.repeat(64) })],
    ['another algorithm', (c: PowChallenge) => tokenOf(c, { algorithm: 'SHA-1' })],
    ['text that is not base64 JSON', () => 'not a solution'],
    ['an oversized token', () => 'x'.repeat(5000)],
  ])('refuses %s', (_label, tamper) => {
    expect(
      verifyPowSolution({ key: KEY, token: tamper(issued), surface: 'web-form', now: NOW }),
    ).toEqual({ success: false, errorCodes: ['invalid-input-response'] });
  });
});
