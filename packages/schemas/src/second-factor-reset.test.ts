import { describe, expect, it } from 'vitest';
import {
  secondFactorResetRequestSchema,
  secondFactorSummarySchema,
} from './second-factor-reset.js';

const DIGEST = 'a'.repeat(64);

describe('secondFactorResetRequestSchema', () => {
  it('takes one step-up proof and the digest of the confirmed factors', () => {
    expect(
      secondFactorResetRequestSchema.safeParse({
        proof: { currentPassword: 'a long enough account password' },
        digest: DIGEST,
      }).success,
    ).toBe(true);
    expect(
      secondFactorResetRequestSchema.safeParse({ proof: { code: '123456' }, digest: DIGEST })
        .success,
    ).toBe(true);
  });

  it.each([
    ['no proof', { proof: {}, digest: DIGEST }],
    ['two proofs', { proof: { currentPassword: 'x', code: '123456' }, digest: DIGEST }],
    ['no digest', { proof: { code: '123456' } }],
    ['a digest that is not sha-256 hex', { proof: { code: '123456' }, digest: 'abc' }],
  ])('refuses %s', (_label, body) => {
    expect(secondFactorResetRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('secondFactorSummarySchema', () => {
  it('refuses negative counts', () => {
    expect(
      secondFactorSummarySchema.safeParse({
        totp: true,
        passkeys: -1,
        recoveryCodes: 0,
        digest: DIGEST,
      }).success,
    ).toBe(false);
  });
});
