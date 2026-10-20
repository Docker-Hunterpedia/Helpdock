/**
 * The web form's built-in check (ADR 0052, artboard `HelpCenter/WebForm-Verify`),
 * inline under the page's nonce: the page has no other script, and no script
 * from another host (ADR 0013).
 *
 * It finds the number whose `SHA-256(salt + number)` is the challenge with
 * WebCrypto, 64 digests at a time, puts the ALTCHA solution in the hidden
 * field, and only then enables Send. "Try again" asks the form's
 * `…/challenge` for a new challenge. Without JavaScript the strip keeps the
 * "needs JavaScript" words the server drew.
 *
 * Kept as plain ES2020 text: it is served as is, with no build step.
 */
export const POW_SCRIPT = `(() => {
  const box = document.getElementById('wf-pow');
  if (!box) return;
  const form = box.closest('form');
  const send = form.querySelector('button[type="submit"]');
  const field = box.querySelector('input[type="hidden"]');
  const text = box.querySelector('.hd-pow-text');
  const retry = box.querySelector('.hd-pow-retry');
  let challenge = JSON.parse(box.dataset.challenge);
  const show = (state) => {
    box.dataset.state = state;
    box.setAttribute('role', state === 'failed' ? 'alert' : 'status');
    text.textContent = box.dataset[state];
    retry.hidden = state !== 'failed';
    send.disabled = state !== 'verified';
  };
  const hex = (buffer) =>
    Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const solve = async (work) => {
    const encoder = new TextEncoder();
    for (let start = 0; start <= work.maxnumber; start += 64) {
      const end = Math.min(start + 64, work.maxnumber + 1);
      const digests = [];
      for (let n = start; n < end; n += 1) {
        digests.push(crypto.subtle.digest('SHA-256', encoder.encode(work.salt + n)));
      }
      const found = (await Promise.all(digests)).findIndex((d) => hex(d) === work.challenge);
      if (found >= 0) return start + found;
    }
    throw new Error('unsolved');
  };
  const run = async (fresh) => {
    show('checking');
    field.value = '';
    try {
      if (fresh) {
        const response = await fetch(box.dataset.refresh, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error('challenge');
        challenge = await response.json();
      }
      const number = await solve(challenge);
      field.value = btoa(JSON.stringify({
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        number,
        salt: challenge.salt,
        signature: challenge.signature,
      }));
      show('verified');
    } catch {
      show('failed');
    }
  };
  retry.addEventListener('click', () => run(true));
  run(false);
})();`;
