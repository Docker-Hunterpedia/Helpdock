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
 * algorithm and FIPS constants as the widget's `captcha/sha256.ts`, built once
 * when the page loads; `pow-script.test.ts` checks it against `node:crypto`.
 */
export const POW_SHA256_SOURCE = `(() => {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const rot = (v, b) => (v >>> b) | (v << (32 - b));
  return (bytes) => {
    const words = new Uint32Array(((bytes.length + 8) >> 6) * 16 + 16);
    bytes.forEach((byte, i) => { words[i >> 2] |= byte << (24 - (i % 4) * 8); });
    words[bytes.length >> 2] |= 0x80 << (24 - (bytes.length % 4) * 8);
    words[words.length - 1] = bytes.length * 8;
    const hash = Uint32Array.from(H);
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
  };
})()`;

export const POW_SCRIPT = `(() => {
  const box = document.getElementById('wf-pow');
  if (!box) return;
  const form = box.closest('form');
  const send = form.querySelector('button[type="submit"]');
  const field = box.querySelector('input[type="hidden"]');
  const text = box.querySelector('.hd-pow-text');
  const retry = box.querySelector('.hd-pow-retry');
  const plain = ${POW_SHA256_SOURCE};
  const native = Boolean(globalThis.crypto && crypto.subtle && crypto.subtle.digest);
  const digest = native
    ? async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    : async (bytes) => plain(bytes);
  // The plain digest runs on the page's own thread and resolves on microtasks:
  // without a real task between batches, a solve would freeze the page.
  const batchSize = native ? 64 : 512;
  // A message, not scheduler.yield: its continuation outranks the page's own
  // tasks, so timers starve; and not setTimeout, which nested is clamped to 4 ms.
  const nextTask = () =>
    new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
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
    for (let start = 0; start <= work.maxnumber; start += batchSize) {
      if (!native) await nextTask();
      if (mine !== round) throw new Error('abandoned');
      const end = Math.min(start + batchSize, work.maxnumber + 1);
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
