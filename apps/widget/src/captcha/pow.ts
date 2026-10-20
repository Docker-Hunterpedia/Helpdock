import type { CaptchaChallenge } from '../transport/types.js';
import { sha256 } from './sha256.js';

/**
 * The built-in check's solver (ADR 0052), in the lazy CAPTCHA chunk: find the
 * number whose `SHA-256(salt + number)` is the challenge and answer the ALTCHA
 * solution the api expects as `captchaToken`.
 *
 * WebCrypto where the page has it; on an `http://` page, which has no
 * `crypto.subtle`, the plain-JavaScript digest, slower but the same answer.
 * Digests go out in batches: one `await` per number would spend more time
 * hopping between the page and the crypto thread than hashing. Between
 * batches the solver checks `signal`, so a closed form stops the work.
 */

const BATCH = 64;

/** Refresh this long before the challenge lapses, so a slow typist never sends an expired one. */
const REFRESH_MARGIN_MS = 60_000;
/** Never sooner than this, whatever the server says: a refresh is a new solve. */
const REFRESH_FLOOR_MS = 60_000;

type Digest = (bytes: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;

const webCryptoDigest: Digest = async (bytes) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const plainDigest: Digest = async (bytes) => sha256(bytes);

const digestOf = (): Digest =>
  typeof globalThis.crypto?.subtle?.digest === 'function' ? webCryptoDigest : plainDigest;

const bytesOfHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

export async function solvePow(work: CaptchaChallenge, signal?: AbortSignal): Promise<string> {
  const digest = digestOf();
  const encoder = new TextEncoder();
  const target = bytesOfHex(work.challenge);
  for (let start = 0; start <= work.maxnumber; start += BATCH) {
    signal?.throwIfAborted();
    const end = Math.min(start + BATCH, work.maxnumber + 1);
    const digests: Promise<Uint8Array>[] = [];
    for (let n = start; n < end; n += 1) {
      digests.push(digest(encoder.encode(`${work.salt}${String(n)}`)));
    }
    const batch = await Promise.all(digests);
    signal?.throwIfAborted();
    const found = batch.findIndex((candidate) => same(candidate, target));
    if (found >= 0) {
      return btoa(
        JSON.stringify({
          algorithm: work.algorithm,
          challenge: work.challenge,
          number: start + found,
          salt: work.salt,
          signature: work.signature,
        }),
      );
    }
  }
  throw new Error('No number solves this challenge');
}

/**
 * How long a solution is worth keeping, counted from when the challenge
 * arrived: the server's `expiresIn`, not the `expires` in the salt, which a
 * device clock that is off would misread.
 */
export function refreshAfter(work: CaptchaChallenge): number {
  return Math.max(work.expiresIn * 1000 - REFRESH_MARGIN_MS, REFRESH_FLOOR_MS);
}
