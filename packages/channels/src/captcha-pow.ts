import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { CaptchaSurface } from './captcha.js';

/**
 * The built-in proof-of-work CAPTCHA, `pow` (ADR 0052, M18-10).
 *
 * The api signs `{ algorithm, challenge, salt, maxnumber }`: `challenge` is
 * `SHA-256(salt + n)` for a secret `n` in `[0, maxnumber]`, and `signature`
 * is HMAC-SHA256 over `challenge` under a key the api derives from
 * `APP_MASTER_KEY`. The visitor's browser finds `n` by trying each number,
 * and posts back the base64 JSON `{ algorithm, challenge, number, salt,
 * signature }`. That is the ALTCHA protocol, so an operator could swap in the
 * ALTCHA widget later.
 *
 * `salt` carries `?expires=<unix seconds>&surface=<surface>`. Changing either
 * changes `SHA-256(salt + n)`, so they are covered by the signature without a
 * second MAC. Single use is not decided here: the caller spends `challenge`
 * once in Redis, for as long as {@link PowVerdict} says it stays valid.
 *
 * Cost, not detection: it raises the price of a naive flood, never of a
 * determined attacker, and it sits on top of the origin check and the rate
 * limits, never in their place.
 */

export type PowDifficulty = 'low' | 'medium';

/**
 * The search space. The browser tries half of it on average: `low` is about
 * half a second on a 2020 mid-range Android, `medium` about four times that.
 */
export const POW_MAX_NUMBER: Readonly<Record<PowDifficulty, number>> = {
  low: 50_000,
  medium: 200_000,
};

/** Long enough to type a message after the form opens; the widget fetches a new one before it lapses. */
export const POW_TTL_SECONDS = 15 * 60;

export interface PowChallenge {
  readonly algorithm: 'SHA-256';
  readonly challenge: string;
  readonly maxnumber: number;
  readonly salt: string;
  readonly signature: string;
}

export type PowVerdict =
  | {
      readonly success: true;
      /** The challenge to spend once. */
      readonly challenge: string;
      /** How long it stays spendable, so the spend record can expire with it. */
      readonly remainingMs: number;
    }
  | { readonly success: false; readonly errorCodes: readonly string[] };

/** A solution is a couple of hundred bytes; far more is not one. */
const MAX_TOKEN_LENGTH = 2048;

const HEX_64 = /^[0-9a-f]{64}$/;

const solutionSchema = z.object({
  algorithm: z.literal('SHA-256'),
  challenge: z.string().regex(HEX_64),
  number: z.number().int().min(0).max(POW_MAX_NUMBER.medium),
  salt: z.string().max(256),
  signature: z.string().regex(HEX_64),
});

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const signatureOf = (key: Buffer, challenge: string): string =>
  createHmac('sha256', key).update(challenge, 'utf8').digest('hex');

const sameHex = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

export const createPowChallenge = ({
  key,
  difficulty,
  surface,
  now = Date.now(),
}: {
  readonly key: Buffer;
  readonly difficulty: PowDifficulty;
  readonly surface: CaptchaSurface;
  readonly now?: number;
}): PowChallenge => {
  const maxnumber = POW_MAX_NUMBER[difficulty];
  const expires = Math.floor(now / 1000) + POW_TTL_SECONDS;
  const salt = `${randomBytes(12).toString('hex')}?expires=${String(expires)}&surface=${surface}`;
  const challenge = sha256Hex(`${salt}${String(randomInt(0, maxnumber + 1))}`);
  return {
    algorithm: 'SHA-256',
    challenge,
    maxnumber,
    salt,
    signature: signatureOf(key, challenge),
  };
};

const decode = (token: string): z.infer<typeof solutionSchema> | null => {
  if (token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  try {
    const parsed = solutionSchema.safeParse(
      JSON.parse(Buffer.from(token, 'base64').toString('utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    // Not base64 JSON: refused below like any other malformed answer.
    return null;
  }
};

const refuse = (code: string): PowVerdict => ({ success: false, errorCodes: [code] });

/** Is this a solution of a challenge this key signed, for this surface, still in time? */
export const verifyPowSolution = ({
  key,
  token,
  surface,
  now = Date.now(),
}: {
  readonly key: Buffer;
  readonly token: string;
  readonly surface: CaptchaSurface;
  readonly now?: number;
}): PowVerdict => {
  const solution = decode(token);
  if (solution === null) {
    return refuse('invalid-input-response');
  }
  const params = new URLSearchParams(solution.salt.split('?')[1] ?? '');
  const expiresMs = Number(params.get('expires')) * 1000;
  if (
    !sameHex(signatureOf(key, solution.challenge), solution.signature) ||
    sha256Hex(`${solution.salt}${String(solution.number)}`) !== solution.challenge
  ) {
    return refuse('invalid-input-response');
  }
  if (params.get('surface') !== surface) {
    return refuse('action-mismatch');
  }
  if (!Number.isFinite(expiresMs) || expiresMs <= now) {
    return refuse('timeout-or-duplicate');
  }
  return { success: true, challenge: solution.challenge, remainingMs: expiresMs - now };
};
