import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WEBHOOK_SECRET_PREFIX } from '@helpdock/schemas';

/**
 * The signature every delivery carries (M8-03, REQUIREMENTS §4.12):
 *
 * ```
 * X-Helpdock-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>
 * ```
 *
 * The timestamp is inside the signed bytes, so a receiver that refuses an old
 * `t` refuses a replayed request too. `v1` names the scheme, so a second one
 * can be added beside it without breaking receivers that know the first.
 */

/** How old a signature a receiver should accept, by default. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const SECRET_BYTES = 32;

export const issueWebhookSecret = (): string =>
  `${WEBHOOK_SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString('base64url')}`;

const hmac = (secret: string, timestamp: number, body: string): string =>
  createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`)
    .digest('hex');

export const signWebhook = (secret: string, timestamp: number, body: string): string =>
  `t=${String(timestamp)},v1=${hmac(secret, timestamp, body)}`;

/**
 * What a receiver runs, here so the docs' example and the tests use the same
 * code: the header must parse, be recent, and match in constant time.
 */
export const verifyWebhookSignature = ({
  secret,
  header,
  body,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
}: {
  readonly secret: string;
  readonly header: string;
  readonly body: string;
  readonly nowSeconds?: number;
  readonly toleranceSeconds?: number;
}): boolean => {
  const parts = new Map(
    header.split(',').map((part) => {
      const [name = '', value = ''] = part.split('=', 2);
      return [name.trim(), value.trim()] as const;
    }),
  );
  const timestamp = Number(parts.get('t'));
  const given = parts.get('v1') ?? '';
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return false;
  }

  const expected = Buffer.from(hmac(secret, timestamp, body), 'hex');
  const actual = Buffer.from(given, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
