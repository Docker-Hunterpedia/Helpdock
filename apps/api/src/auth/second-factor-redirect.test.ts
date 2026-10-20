import { describe, expect, it } from 'vitest';
import { factorsParams } from './second-factor-redirect.js';

describe('factorsParams', () => {
  it('adds nothing for an authenticator app alone, so older links read the same', () => {
    expect(factorsParams({ totp: true, passkey: false })).toEqual({});
  });

  it.each([
    [{ totp: true, passkey: true }, 'totp,passkey'],
    [{ totp: false, passkey: true }, 'passkey'],
  ])('names every way that can answer: %o', (factors, expected) => {
    expect(factorsParams(factors)).toEqual({ factors: expected });
  });
});
