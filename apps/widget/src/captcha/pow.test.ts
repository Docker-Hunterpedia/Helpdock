import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptchaChallenge } from '../transport/types.js';
import { refreshAfter, solvePow } from './pow.js';
import { sha256 } from './sha256.js';

const NOW = Date.UTC(2026, 9, 20, 12);
const EXPIRES = NOW / 1000 + 900;

/** A challenge as the api signs one, with a known answer. */
const challengeFor = (number: number, maxnumber = 300): CaptchaChallenge => {
  const salt = `abc123?expires=${String(EXPIRES)}&surface=widget-first-message&`;
  return {
    algorithm: 'SHA-256',
    challenge: createHash('sha256')
      .update(`${salt}${String(number)}`)
      .digest('hex'),
    maxnumber,
    salt,
    signature: 'f'.repeat(64),
    expiresIn: 900,
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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

  it('solves on an http:// page, where there is no crypto.subtle', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });

    expect(JSON.parse(atob(await solvePow(challengeFor(200)))).number).toBe(200);
  });

  it('lets the page run a timer while it solves without WebCrypto', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const events: string[] = [];

    const solving = solvePow(challengeFor(3000, 3000)).then(() => events.push('solved'));
    setTimeout(() => events.push('timer'), 0);
    await solving;

    expect(events).toEqual(['timer', 'solved']);
  });

  it('stops mid-solve without WebCrypto once the form is closed', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const closed = new AbortController();
    // No number up to 200,000 solves this: only an abort can end it early.
    const solving = solvePow(
      { ...challengeFor(0, 200_000), challenge: '0'.repeat(64) },
      closed.signal,
    );
    setTimeout(() => closed.abort(), 0);

    await expect(solving).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stops between batches once the form is closed', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const closed = new AbortController();
    const solving = solvePow(challengeFor(300), closed.signal);
    closed.abort();

    await expect(solving).rejects.toThrow();
    expect(digest.mock.calls.length).toBeLessThanOrEqual(64);
  });
});

describe('sha256', () => {
  it.each([
    '',
    'abc',
    'a'.repeat(55),
    'a'.repeat(56),
    'a'.repeat(64),
    'abc123?expires=1792497600&surface=web-form&49999',
    'نتحقّق',
  ])('agrees with node:crypto on %j', (text) => {
    const bytes = new TextEncoder().encode(text);

    expect(Buffer.from(sha256(bytes)).toString('hex')).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
  });
});

describe('refreshAfter', () => {
  it('fetches new work a minute before the old lapses, counted from its arrival', () => {
    expect(refreshAfter(challengeFor(1))).toBe(840_000);
  });

  it('is the same on a device whose clock is twenty minutes fast', () => {
    vi.useFakeTimers({ now: NOW + 20 * 60_000 });

    expect(refreshAfter(challengeFor(1))).toBe(840_000);
  });

  it('never refreshes sooner than a minute', () => {
    expect(refreshAfter({ ...challengeFor(1), expiresIn: 30 })).toBe(60_000);
  });
});
