/**
 * SHA-256 in plain JavaScript (FIPS 180-4), for the built-in check on a page
 * WebCrypto refuses to serve: `crypto.subtle` exists only in a secure context,
 * and a brand's site may still be on `http://` (ADR 0052). It is several times
 * slower than WebCrypto, so the solver uses it only when it has to.
 *
 * The constants are FIPS 180-4's own (§4.2.2 and §5.3.3), spelled out rather
 * than derived, so nothing depends on how a browser rounds `Math.cbrt`.
 */

/** The 64 round constants. */
const ROUND = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** The initial hash value. */
const INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

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
