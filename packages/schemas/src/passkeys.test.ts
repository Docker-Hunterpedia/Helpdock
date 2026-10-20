import { describe, expect, it } from 'vitest';
import {
  enrolmentPasskeyConfirmRequestSchema,
  MAX_PASSKEYS_PER_ACCOUNT,
  passkeyAddedSchema,
  passkeyFinishRequestSchema,
  passkeyNameSchema,
  passkeyProofSchema,
  passkeyRecoveryRedrawRequestSchema,
  passkeySecondFactorOptionsRequestSchema,
  passkeySecondFactorVerifyRequestSchema,
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

  it.each([
    '',
    '   ',
    'x'.repeat(65),
    'tab\there',
    'bell\u0007',
    'nul\u0000',
    'rtl\u202eoverride',
    'iso\u2066late',
    'zero\u200bwidth',
    'bom\ufeffname',
  ])('refuses %j', (name) => {
    expect(passkeyNameSchema.safeParse(name).success).toBe(false);
  });
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

describe('a passkey as the second factor (M18-03)', () => {
  it('needs the challenge, the ceremony, the answer and whether to trust the browser', () => {
    const body = {
      challengeId: 'c1',
      ceremonyId: CEREMONY_ID,
      response: assertion,
      trustDevice: false,
    };

    expect(passkeySecondFactorVerifyRequestSchema.safeParse(body).success).toBe(true);
    for (const missing of ['challengeId', 'ceremonyId', 'response', 'trustDevice']) {
      expect(
        passkeySecondFactorVerifyRequestSchema.safeParse({ ...body, [missing]: undefined }).success,
      ).toBe(false);
    }
  });

  it('refuses an empty challenge and a ceremony that is not 256 bits', () => {
    expect(passkeySecondFactorOptionsRequestSchema.safeParse({ challengeId: '' }).success).toBe(
      false,
    );
    expect(
      passkeySecondFactorVerifyRequestSchema.safeParse({
        challengeId: 'c1',
        ceremonyId: 'short',
        response: assertion,
        trustDevice: false,
      }).success,
    ).toBe(false);
  });

  it('needs a name to enrol a passkey from a challenge', () => {
    const body = {
      challengeId: 'c1',
      ceremonyId: CEREMONY_ID,
      response: {
        id: 'AQID',
        rawId: 'AQID',
        type: 'public-key',
        response: { clientDataJSON: 'e30', attestationObject: 'o2NmbXRkbm9uZQ' },
        clientExtensionResults: {},
      },
      name: 'MacBook',
    };

    expect(enrolmentPasskeyConfirmRequestSchema.safeParse(body).success).toBe(true);
    expect(enrolmentPasskeyConfirmRequestSchema.safeParse({ ...body, name: '' }).success).toBe(
      false,
    );
  });

  it('carries recovery codes on an added passkey only when there are some', () => {
    const passkey = {
      id: '0190a1f2-4c3b-7d2e-8f10-1a2b3c4d5e6f',
      name: 'Key',
      createdAt: '2026-10-20T10:00:00.000Z',
      lastUsedAt: null,
      synced: false,
    };

    expect(passkeyAddedSchema.parse(passkey)).not.toHaveProperty('recoveryCodes');
    expect(passkeyAddedSchema.parse({ ...passkey, recoveryCodes: ['AAAA-1111'] })).toMatchObject({
      recoveryCodes: ['AAAA-1111'],
    });
  });

  it('redraws the recovery codes only with an assertion', () => {
    expect(passkeyRecoveryRedrawRequestSchema.safeParse({}).success).toBe(false);
    expect(
      passkeyRecoveryRedrawRequestSchema.safeParse({
        passkey: { ceremonyId: CEREMONY_ID, response: assertion },
      }).success,
    ).toBe(true);
  });
});

it('allows ten passkeys per account', () => {
  expect(MAX_PASSKEYS_PER_ACCOUNT).toBe(10);
});
