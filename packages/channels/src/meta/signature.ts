import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The two checks a Meta webhook starts with, before its body is read for
 * anything else (ADR 0025, 4): the handshake that registers the callback URL,
 * and the `X-Hub-Signature-256` every delivery carries.
 *
 * Both compare secrets in constant time. The api's Telegram route does the
 * same for its `X-Telegram-Bot-Api-Secret-Token` (`sameSecret`).
 */

const SIGNATURE = /^sha256=([0-9a-f]{64})$/i;

/** `sha256=<hex>` of `raw` under `secret`: the value Meta puts in the header. */
export const hubSignature = (raw: Uint8Array, secret: string): string =>
  `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

/**
 * The first of `secrets` whose HMAC-SHA256 over the **raw bytes** of the body
 * is `header`, or undefined when none is. Two secrets are normal: Meta signs
 * most webhooks with the app secret and, under Instagram Login, may sign
 * Instagram's with the Instagram app secret, and which it is has not been
 * confirmed (the milestone's open questions), so either is accepted. Which one
 * signed is the caller's to weigh against what the body says it is.
 *
 * An empty secret is skipped, never matched: a key of zero bytes is a key
 * anybody can sign with. Every secret is tried even after one matches, so the
 * time taken does not say which of them signed.
 */
export const matchHubSignature = (
  raw: Uint8Array,
  header: string | undefined,
  secrets: readonly string[],
): string | undefined => {
  const match = header === undefined ? null : SIGNATURE.exec(header.trim());
  if (match === null) {
    return undefined;
  }
  const presented = Buffer.from(match[1] ?? '', 'hex');

  let signedWith: string | undefined;
  for (const secret of secrets) {
    if (secret === '') {
      continue;
    }
    const expected = createHmac('sha256', secret).update(raw).digest();
    if (timingSafeEqual(expected, presented)) {
      signedWith ??= secret;
    }
  }

  return signedWith;
};

/** Whether `header` is the signature of `raw` under any of `secrets`. */
export const verifyHubSignature = (
  raw: Uint8Array,
  header: string | undefined,
  secrets: readonly string[],
): boolean => matchHubSignature(raw, header, secrets) !== undefined;

/** Compares two strings in constant time whatever their lengths. */
const sameText = (a: string, b: string): boolean =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/** The longest challenge echoed back. Meta sends a number; nothing longer is believed. */
const MAX_CHALLENGE_LENGTH = 256;

/** Printable ASCII only: no control character, so the answer cannot split a header. */
const PRINTABLE = /^[\x20-\x7e]+$/;

const firstOf = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined;
  }
  return typeof value === 'string' ? value : undefined;
};

/**
 * One handshake parameter, whether the query parser kept `hub.mode` as a flat
 * key (Fastify) or nested it as `hub: { mode }` (a `qs`-style parser).
 */
const hubParam = (query: Readonly<Record<string, unknown>>, name: string): string | undefined => {
  const flat = firstOf(query[`hub.${name}`]);
  if (flat !== undefined) {
    return flat;
  }
  const nested = query.hub;
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? firstOf((nested as Readonly<Record<string, unknown>>)[name])
    : undefined;
};

/**
 * The handshake: `GET <callback>?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`.
 * Returns the challenge to echo as the 200 body when the mode is `subscribe` and
 * the token is `verifyToken`, and null (the route answers 403) otherwise. An
 * install with no verify token yet answers nobody.
 */
export const hubChallenge = (
  query: Readonly<Record<string, unknown>>,
  verifyToken: string,
): string | null => {
  const mode = hubParam(query, 'mode');
  const token = hubParam(query, 'verify_token');
  const challenge = hubParam(query, 'challenge');

  // Compared even when the mode is wrong, so a refusal takes as long as an answer.
  const sameToken = sameText(token ?? '', verifyToken);
  if (mode !== 'subscribe' || !sameToken || verifyToken === '' || token === undefined) {
    return null;
  }
  if (
    challenge === undefined ||
    challenge.length === 0 ||
    challenge.length > MAX_CHALLENGE_LENGTH ||
    !PRINTABLE.test(challenge)
  ) {
    return null;
  }

  return challenge;
};
