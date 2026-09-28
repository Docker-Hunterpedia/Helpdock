import { createHash, createHmac } from 'node:crypto';
import { canonicalIdentityJson, type SignedIdentity } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  checkSignedIdentity,
  hashVisitorSecret,
  issueSigningSecret,
  issueVisitorSecret,
  visitorSecretFrom,
} from './visitor-credential.js';

const SIGNING = 'hdws_test-signing-secret';
const NOW = new Date('2026-09-27T10:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);

const signed = (payload: SignedIdentity['payload'], key = SIGNING): SignedIdentity => ({
  payload,
  signature: createHmac('sha256', key).update(canonicalIdentityJson(payload)).digest('hex'),
});

describe('the visitor secret', () => {
  it('is 256 random bits, and only its sha256 is kept', () => {
    const secret = issueVisitorSecret();

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issueVisitorSecret()).not.toBe(secret);
    expect(hashVisitorSecret(secret)).toBe(createHash('sha256').update(secret).digest('hex'));
  });

  it('is read from the Visitor scheme alone', () => {
    const secret = issueVisitorSecret();

    expect(visitorSecretFrom(`Visitor ${secret}`)).toBe(secret);
    expect(visitorSecretFrom(`visitor ${secret}`)).toBe(secret);
    expect(visitorSecretFrom([`Visitor ${secret}`])).toBe(secret);
    expect(visitorSecretFrom(`Bearer ${secret}`)).toBeNull();
    expect(visitorSecretFrom('Visitor too-short')).toBeNull();
    expect(visitorSecretFrom(undefined)).toBeNull();
  });
});

describe('checkSignedIdentity', () => {
  it('accepts a signature over the canonical payload within five minutes either way', () => {
    expect(checkSignedIdentity(signed({ user_id: 'u-1', ts: NOW_S }), SIGNING, NOW)).toBe('valid');
    expect(checkSignedIdentity(signed({ user_id: 'u-1', ts: NOW_S - 300 }), SIGNING, NOW)).toBe(
      'valid',
    );
    expect(
      checkSignedIdentity(
        signed({ user_id: 'u-1', email: 'a@b.c', name: 'A', ts: NOW_S + 300 }),
        SIGNING,
        NOW,
      ),
    ).toBe('valid');
  });

  it('tells a forged signature from a stale one', () => {
    expect(checkSignedIdentity(signed({ user_id: 'u-1', ts: NOW_S }, 'other'), SIGNING, NOW)).toBe(
      'bad_signature',
    );
    expect(checkSignedIdentity(signed({ user_id: 'u-1', ts: NOW_S - 301 }), SIGNING, NOW)).toBe(
      'expired',
    );
  });

  it('refuses a payload changed after signing', () => {
    const identity = signed({ user_id: 'u-1', ts: NOW_S });

    expect(
      checkSignedIdentity(
        { ...identity, payload: { ...identity.payload, user_id: 'u-2' } },
        SIGNING,
        NOW,
      ),
    ).toBe('bad_signature');
  });
});

describe('issueSigningSecret', () => {
  it('is prefixed and random', () => {
    expect(issueSigningSecret()).toMatch(/^hdws_[A-Za-z0-9_-]{43}$/);
    expect(issueSigningSecret()).not.toBe(issueSigningSecret());
  });

  it('keeps verifying a secret issued with the earlier whsec_ prefix', () => {
    const legacy = 'whsec_legacy-signing-secret';
    const identity = signed({ user_id: 'u-1', ts: NOW_S }, legacy);

    expect(checkSignedIdentity(identity, legacy, NOW)).toBe('valid');
  });
});
