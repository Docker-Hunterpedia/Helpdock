import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueWebhookSecret, signWebhook, verifyWebhookSignature } from './webhook-signature.js';

const SECRET = 'whsec_test';
const BODY = '{"id":"evt","event":"ticket.created"}';
const NOW = 1_790_000_000;

describe('signWebhook', () => {
  it('is t=<seconds>,v1=<hex HMAC-SHA256 of "t.body">', () => {
    const expected = createHmac('sha256', SECRET).update(`${NOW}.${BODY}`).digest('hex');

    expect(signWebhook(SECRET, NOW, BODY)).toBe(`t=${NOW},v1=${expected}`);
  });
});

describe('verifyWebhookSignature', () => {
  const header = signWebhook(SECRET, NOW, BODY);

  it('accepts its own signature within the tolerance', () => {
    expect(
      verifyWebhookSignature({ secret: SECRET, header, body: BODY, nowSeconds: NOW + 60 }),
    ).toBe(true);
  });

  it.each([
    ['another body', { body: `${BODY} ` }],
    ['another secret', { secret: 'whsec_other' }],
    ['a stale timestamp', { nowSeconds: NOW + 301 }],
    ['a header without v1', { header: `t=${NOW}` }],
    ['a header that is not one', { header: 'garbage' }],
  ])('refuses %s', (_label, change) => {
    expect(
      verifyWebhookSignature({ secret: SECRET, header, body: BODY, nowSeconds: NOW, ...change }),
    ).toBe(false);
  });
});

describe('issueWebhookSecret', () => {
  it('issues a whsec_ secret with 256 bits of randomness, never twice the same', () => {
    const secret = issueWebhookSecret();

    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(issueWebhookSecret()).not.toBe(secret);
  });
});
