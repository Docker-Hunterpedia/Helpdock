/**
 * The web form's built-in check (ADR 0052, artboard `HelpCenter/WebForm-Verify`),
 * inline under the page's nonce: the page has no other script, and no script
 * from another host (ADR 0013).
 *
 * It finds the number whose `SHA-256(salt + number)` is the challenge, 64
 * digests at a time, compared as bytes against the challenge decoded once,
 * puts the ALTCHA solution in the hidden field, and only then enables Send.
 * "Try again" asks the form's `…/challenge` for a new challenge, and abandons
 * a solve still running. Without JavaScript the strip keeps the "needs
 * JavaScript" words the server drew.
 *
 * Kept as plain ES2020 text: it is served as is, with no build step, so it
 * cannot import the widget's solver and carries its own copy of the same
 * steps.
 */

/**
 * SHA-256 in plain JavaScript (FIPS 180-4) for a form served over `http://`,
 * where the browser has no `crypto.subtle`: slower, the same answer. The same
 * algorithm as the widget's `captcha/sha256.ts`; `pow-script.test.ts` checks
 * it against `node:crypto`.
 */
export const POW_SHA256_SOURCE = `(bytes) => {
  const primes = [];
  for (let n = 2; primes.length < 64; n += 1) {
    if (primes.every((p) => n % p !== 0)) primes.push(n);
  }
  const frac = (v) => ((v - Math.floor(v)) * 2 ** 32) >>> 0;
  const K = primes.map((p) => frac(Math.cbrt(p)));
  const rot = (v, b) => (v >>> b) | (v << (32 - b));
  const words = new Uint32Array(((bytes.length + 8) >> 6) * 16 + 16);
  bytes.forEach((byte, i) => { words[i >> 2] |= byte << (24 - (i % 4) * 8); });
  words[bytes.length >> 2] |= 0x80 << (24 - (bytes.length % 4) * 8);
  words[words.length - 1] = bytes.length * 8;
  const hash = Uint32Array.from(primes.slice(0, 8), (p) => frac(Math.sqrt(p)));
  const w = new Uint32Array(64);
  for (let block = 0; block < words.length; block += 16) {
    for (let t = 0; t < 64; t += 1) {
      w[t] = t < 16 ? words[block + t]
        : w[t - 16] + (rot(w[t - 15], 7) ^ rot(w[t - 15], 18) ^ (w[t - 15] >>> 3))
          + w[t - 7] + (rot(w[t - 2], 17) ^ rot(w[t - 2], 19) ^ (w[t - 2] >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let t = 0; t < 64; t += 1) {
      const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) >>> 0;
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { hash[i] += v; });
  }
  const out = new Uint8Array(32);
  hash.forEach((v, i) => { out[i * 4] = v >>> 24; out[i * 4 + 1] = v >>> 16; out[i * 4 + 2] = v >>> 8; out[i * 4 + 3] = v; });
  return out;
}`;

export const POW_SCRIPT = `(() => {
  const box = document.getElementById('wf-pow');
  if (!box) return;
  const form = box.closest('form');
  const send = form.querySelector('button[type="submit"]');
  const field = box.querySelector('input[type="hidden"]');
  const text = box.querySelector('.hd-pow-text');
  const retry = box.querySelector('.hd-pow-retry');
  const plain = ${POW_SHA256_SOURCE};
  const digest = globalThis.crypto && crypto.subtle && crypto.subtle.digest
    ? async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    : async (bytes) => plain(bytes);
  let challenge = JSON.parse(box.dataset.challenge);
  let round = 0;
  const show = (state) => {
    box.dataset.state = state;
    box.setAttribute('role', state === 'failed' ? 'alert' : 'status');
    text.textContent = box.dataset[state];
    retry.hidden = state !== 'failed';
    send.disabled = state !== 'verified';
  };
  const solve = async (work, mine) => {
    const encoder = new TextEncoder();
    const target = Uint8Array.from(work.challenge.match(/../g), (pair) => parseInt(pair, 16));
    for (let start = 0; start <= work.maxnumber; start += 64) {
      const end = Math.min(start + 64, work.maxnumber + 1);
      const digests = [];
      for (let n = start; n < end; n += 1) {
        digests.push(digest(encoder.encode(work.salt + n)));
      }
      const batch = await Promise.all(digests);
      if (mine !== round) throw new Error('abandoned');
      const found = batch.findIndex((d) => d.every((byte, i) => byte === target[i]));
      if (found >= 0) return start + found;
    }
    throw new Error('unsolved');
  };
  const run = async (fresh) => {
    round += 1;
    const mine = round;
    show('checking');
    field.value = '';
    try {
      if (fresh) {
        const response = await fetch(box.dataset.refresh, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error('challenge');
        challenge = await response.json();
      }
      const number = await solve(challenge, mine);
      field.value = btoa(JSON.stringify({
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        number,
        salt: challenge.salt,
        signature: challenge.signature,
      }));
      show('verified');
    } catch {
      if (mine === round) show('failed');
    }
  };
  retry.addEventListener('click', () => run(true));
  run(false);
})();`;
