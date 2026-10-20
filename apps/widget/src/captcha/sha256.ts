/**
 * SHA-256 in plain JavaScript (FIPS 180-4), for the built-in check on a page
 * WebCrypto refuses to serve: `crypto.subtle` exists only in a secure context,
 * and a brand's site may still be on `http://` (ADR 0052). It is several times
 * slower than WebCrypto, so the solver uses it only when it has to.
 *
 * The constants are the fractional parts of the square and cube roots of the
 * first primes, computed here rather than spelled out: a double carries them
 * to well past the 32 bits the algorithm keeps.
 */

const PRIMES: number[] = [];
for (let candidate = 2; PRIMES.length < 64; candidate += 1) {
  if (PRIMES.every((prime) => candidate % prime !== 0)) {
    PRIMES.push(candidate);
  }
}
const fraction = (value: number): number => ((value - Math.floor(value)) * 2 ** 32) >>> 0;
const INITIAL = PRIMES.slice(0, 8).map((prime) => fraction(Math.sqrt(prime)));
const ROUND = PRIMES.map((prime) => fraction(Math.cbrt(prime)));

const rotate = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

/** The digest of `bytes`, which must be shorter than 512 MB (the length is kept in 32 bits). */
export function sha256(bytes: Uint8Array): Uint8Array {
  const words = new Uint32Array(((bytes.length + 8) >> 6) * 16 + 16);
  bytes.forEach((byte, index) => {
    words[index >> 2] = (words[index >> 2] ?? 0) | (byte << (24 - (index % 4) * 8));
  });
  words[bytes.length >> 2] =
    (words[bytes.length >> 2] ?? 0) | (0x80 << (24 - (bytes.length % 4) * 8));
  words[words.length - 1] = bytes.length * 8;

  const hash = Uint32Array.from(INITIAL);
  const schedule = new Uint32Array(64);
  for (let block = 0; block < words.length; block += 16) {
    for (let t = 0; t < 64; t += 1) {
      if (t < 16) {
        schedule[t] = words[block + t] ?? 0;
      } else {
        const early = schedule[t - 15] ?? 0;
        const late = schedule[t - 2] ?? 0;
        schedule[t] =
          (schedule[t - 16] ?? 0) +
          (rotate(early, 7) ^ rotate(early, 18) ^ (early >>> 3)) +
          (schedule[t - 7] ?? 0) +
          (rotate(late, 17) ^ rotate(late, 19) ^ (late >>> 10));
      }
    }
    let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = hash;
    for (let t = 0; t < 64; t += 1) {
      const first =
        (h +
          (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
          ((e & f) ^ (~e & g)) +
          (ROUND[t] ?? 0) +
          (schedule[t] ?? 0)) >>>
        0;
      const second =
        ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, index) => {
      hash[index] = (hash[index] ?? 0) + value;
    });
  }

  const digest = new Uint8Array(32);
  hash.forEach((value, index) => {
    digest[index * 4] = value >>> 24;
    digest[index * 4 + 1] = value >>> 16;
    digest[index * 4 + 2] = value >>> 8;
    digest[index * 4 + 3] = value;
  });
  return digest;
}
