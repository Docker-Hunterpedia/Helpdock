import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CaptchaChallenge } from '../transport/types.js';
import { refreshAfter, solvePow } from './pow.js';

const NOW = Date.UTC(2026, 9, 20, 12);
const EXPIRES = NOW / 1000 + 900;

/** A challenge as the api signs one, with a known answer. */
const challengeFor = (number: number, maxnumber = 300): CaptchaChallenge => {
  const salt = `abc123?expires=${String(EXPIRES)}&surface=widget-first-message`;
  return {
    algorithm: 'SHA-256',
    challenge: createHash('sha256')
      .update(`${salt}${String(number)}`)
      .digest('hex'),
    maxnumber,
    salt,
    signature: 'f'.repeat(64),
  };
};

describe('solvePow (ADR 0052)', () => {
  // The first and last of a batch of 64, the next batch, and the end of the range.
  it.each([0, 63, 64, 300])('finds %i and answers the ALTCHA solution', async (number) => {
    const work = challengeFor(number);

    expect(JSON.parse(atob(await solvePow(work)))).toEqual({
      algorithm: 'SHA-256',
      challenge: work.challenge,
      number,
      salt: work.salt,
      signature: work.signature,
    });
  });

  it('gives up on a challenge no number in range solves', async () => {
    await expect(solvePow(challengeFor(301))).rejects.toThrow('No number solves this challenge');
  });
});

describe('refreshAfter', () => {
  it('fetches new work a minute before the old lapses', () => {
    expect(refreshAfter(challengeFor(1), NOW)).toBe(840_000);
    expect(refreshAfter(challengeFor(1), NOW + 900_000)).toBe(0);
  });

  it('does not refresh work that names no expiry', () => {
    expect(refreshAfter({ ...challengeFor(1), salt: 'abc123' }, NOW)).toBeNull();
  });
});
