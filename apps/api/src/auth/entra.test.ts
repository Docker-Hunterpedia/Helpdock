import { describe, expect, it } from 'vitest';
import { entraVouchesForEmail } from './entra.js';

const TENANT = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const member = { iss: ISSUER, tid: TENANT, acct: 0, xms_edov: true };

describe('entraVouchesForEmail', () => {
  it("vouches for a verified-domain member of the issuer's own tenant", () => {
    expect(entraVouchesForEmail(ISSUER, member)).toBe(true);
  });

  it.each([
    ['a guest', { acct: 1 }],
    ['no acct claim', { acct: undefined }],
    ['an unverified domain', { xms_edov: false }],
    ['no xms_edov claim', { xms_edov: undefined }],
    ['xms_edov as a string', { xms_edov: 'true' }],
    ['xms_edov as 1', { xms_edov: 1 }],
    ['acct as a string', { acct: '0' }],
    ["another tenant's tid", { tid: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' }],
    [
      'another issuer in the token',
      { iss: 'https://login.microsoftonline.com/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d/v2.0' },
    ],
  ])('does not vouch for %s', (_why, change) => {
    expect(entraVouchesForEmail(ISSUER, { ...member, ...change })).toBe(false);
  });

  it.each([['common'], ['organizations'], ['consumers'], ['9188040d-6c67-4c5b-b112-36a304b66dad']])(
    'never vouches under the %s issuer',
    (tenant) => {
      const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;

      expect(entraVouchesForEmail(issuer, { ...member, iss: issuer, tid: tenant })).toBe(false);
    },
  );

  it('never vouches under a sovereign-cloud or look-alike host', () => {
    const issuer = `https://login.microsoftonline.us/${TENANT}/v2.0`;

    expect(entraVouchesForEmail(issuer, { ...member, iss: issuer })).toBe(false);
  });
});
