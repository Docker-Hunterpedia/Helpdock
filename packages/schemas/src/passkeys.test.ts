import { describe, expect, it } from 'vitest';
import {
  MAX_PASSKEYS_PER_ACCOUNT,
  passkeyFinishRequestSchema,
  passkeyNameSchema,
  passkeyProofSchema,
  registrationResponseSchema,
} from './passkeys.js';

const CEREMONY_ID = 'A'.repeat(43);

const assertion = {
  id: 'AQID',
  rawId: 'AQID',
  type: 'public-key',
  response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA' },
  clientExtensionResults: {},
};

describe('passkeyProofSchema', () => {
  it.each([
    ['a password', { currentPassword: 'a password' }],
    ['a code', { code: '123456' }],
    ['a passkey assertion', { passkey: { ceremonyId: CEREMONY_ID, response: assertion } }],
  ])('takes %s', (_label, proof) => {
    expect(passkeyProofSchema.safeParse(proof).success).toBe(true);
  });

  it.each([
    ['nothing', {}],
    ['two credentials', { currentPassword: 'a password', code: '123456' }],
    [
      'a password and a passkey',
      { currentPassword: 'x', passkey: { ceremonyId: CEREMONY_ID, response: assertion } },
    ],
    ['a code that is not six digits', { code: '12345' }],
    ['an empty password', { currentPassword: '' }],
    ['a ceremony id of the wrong size', { passkey: { ceremonyId: 'short', response: assertion } }],
  ])('refuses %s', (_label, proof) => {
    expect(passkeyProofSchema.safeParse(proof).success).toBe(false);
  });
});

describe('passkeyNameSchema', () => {
  it('trims, and counts characters rather than bytes', () => {
    expect(passkeyNameSchema.parse('  لابتوب لينا  ')).toBe('لابتوب لينا');
    expect(passkeyNameSchema.safeParse('x'.repeat(64)).success).toBe(true);
  });

  it.each(['', '   ', 'x'.repeat(65), 'tab\there', 'bell\u0007', 'nul\u0000'])(
    'refuses %j',
    (name) => {
      expect(passkeyNameSchema.safeParse(name).success).toBe(false);
    },
  );
});

describe('registrationResponseSchema', () => {
  const registration = {
    id: 'AQID',
    rawId: 'AQID',
    type: 'public-key',
    response: { clientDataJSON: 'e30', attestationObject: 'o2NmbXRkbm9uZQ' },
    clientExtensionResults: { credProps: { rk: true }, somethingNew: { a: 1 } },
  };

  it('keeps what the library reads and drops what a browser adds', () => {
    expect(registrationResponseSchema.parse(registration)).toEqual({
      ...registration,
      clientExtensionResults: { credProps: { rk: true } },
    });
  });

  it.each([
    ['a type other than public-key', { type: 'password' }],
    ['an id that is not base64url', { id: 'not base64!' }],
    [
      'an oversized attestation',
      { response: { clientDataJSON: 'e30', attestationObject: 'A'.repeat(16_385) } },
    ],
  ])('refuses %s', (_label, patch) => {
    expect(registrationResponseSchema.safeParse({ ...registration, ...patch }).success).toBe(false);
  });
});

describe('passkeyFinishRequestSchema', () => {
  it('needs the ceremony, the answer and a name', () => {
    expect(passkeyFinishRequestSchema.safeParse({ ceremonyId: CEREMONY_ID }).success).toBe(false);
  });
});

it('allows ten passkeys per account', () => {
  expect(MAX_PASSKEYS_PER_ACCOUNT).toBe(10);
});
