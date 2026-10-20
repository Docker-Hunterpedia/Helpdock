import type { CaptchaChallenge } from '../transport/types.js';

/**
 * The built-in check's solver (ADR 0052), in the lazy CAPTCHA chunk: find the
 * number whose `SHA-256(salt + number)` is the challenge, with WebCrypto, and
 * answer the ALTCHA solution the api expects as `captchaToken`.
 *
 * Digests go out in batches: one `await` per number would spend more time
 * hopping between the page and the crypto thread than hashing.
 */

const BATCH = 64;

/** Refresh this long before the challenge lapses, so a slow typist never sends an expired one. */
const REFRESH_MARGIN_MS = 60_000;

const hex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

export async function solvePow(work: CaptchaChallenge): Promise<string> {
  const encoder = new TextEncoder();
  for (let start = 0; start <= work.maxnumber; start += BATCH) {
    const end = Math.min(start + BATCH, work.maxnumber + 1);
    const digests: Promise<ArrayBuffer>[] = [];
    for (let n = start; n < end; n += 1) {
      digests.push(crypto.subtle.digest('SHA-256', encoder.encode(`${work.salt}${String(n)}`)));
    }
    const found = (await Promise.all(digests)).findIndex(
      (digest) => hex(digest) === work.challenge,
    );
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

/** How long a solution is worth keeping, from the `expires=` the salt carries; null when it names none. */
export function refreshAfter(work: CaptchaChallenge, now = Date.now()): number | null {
  const expires = Number(new URLSearchParams(work.salt.split('?')[1] ?? '').get('expires'));
  return expires > 0 ? Math.max(expires * 1000 - now - REFRESH_MARGIN_MS, 0) : null;
}
