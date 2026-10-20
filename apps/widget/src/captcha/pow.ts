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
 * batches the solver yields to the page when it hashes on the page's thread,
 * and checks `signal`, so a closed form stops the work.
 */

/** Refresh this long before the challenge lapses, so a slow typist never sends an expired one. */
const REFRESH_MARGIN_MS = 60_000;
/** Never sooner than this, whatever the server says: a refresh is a new solve. */
const REFRESH_FLOOR_MS = 60_000;

interface Hasher {
  digest(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array>;
  /** Numbers tried between two checks of the abort signal. */
  readonly batch: number;
  /** Hands the page a task between batches, or nothing when the hashing already does. */
  readonly pause: () => Promise<void>;
}

/** WebCrypto hashes off the page's thread and resolves in tasks of its own. */
const webCrypto: Hasher = {
  digest: async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  batch: 64,
  pause: async () => undefined,
};

/**
 * The plain digest runs on the page's thread and resolves on microtasks, so
 * without a real task between batches a solve would be one long task: the
 * page would freeze and the abort signal could never be seen. Bigger batches
 * keep the cost of those pauses low.
 */
const plain: Hasher = {
  digest: async (bytes) => sha256(bytes),
  batch: 512,
  // A message, not `scheduler.yield`: its continuation outranks the page's
  // own tasks, so their timers would starve; and not `setTimeout`, which
  // nested is clamped to 4 ms a batch.
  pause: () =>
    new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    }),
};

const hasherOf = (): Hasher =>
  typeof globalThis.crypto?.subtle?.digest === 'function' ? webCrypto : plain;

const bytesOfHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

export async function solvePow(work: CaptchaChallenge, signal?: AbortSignal): Promise<string> {
  const hasher = hasherOf();
  const encoder = new TextEncoder();
  const target = bytesOfHex(work.challenge);
  for (let start = 0; start <= work.maxnumber; start += hasher.batch) {
    await hasher.pause();
    signal?.throwIfAborted();
    const end = Math.min(start + hasher.batch, work.maxnumber + 1);
    const digests: Promise<Uint8Array>[] = [];
    for (let n = start; n < end; n += 1) {
      digests.push(hasher.digest(encoder.encode(`${work.salt}${String(n)}`)));
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
