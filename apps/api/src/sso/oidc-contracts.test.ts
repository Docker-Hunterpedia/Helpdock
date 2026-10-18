import { uuidv7 } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import {
  matchesBrowserNonce,
  oidcAssertion,
  oidcNonceCookie,
  ssoHash,
  ssoReturnToSchema,
} from './oidc-contracts.js';

const input = {
  connectionId: uuidv7(),
  claims: {
    sub: 'subject',
    email: 'ada@example.com',
    email_verified: true,
    name: 'Ada',
    groups: ['Support'],
  },
  supplemental: {},
  emailClaim: 'email',
  nameClaim: 'name',
  groupAttribute: 'groups',
};

describe('OIDC claim boundaries', () => {
  it('maps a signed, verified identity and documented string group claims', () => {
    expect(
      oidcAssertion({ ...input, claims: { ...input.claims, groups: 'Support' } }).groups,
    ).toEqual(['Support']);
  });
  it('never promotes a supplementary email or a string verification flag', () => {
    expect(() =>
      oidcAssertion({
        ...input,
        claims: { sub: 'subject', email_verified: 'true' },
        supplemental: input.claims,
      }),
    ).toThrow('sso-email-unverified');
  });
  it('vouches for the address only when it is the verified email claim', () => {
    expect(oidcAssertion(input)).toMatchObject({ email: 'ada@example.com', emailVerified: true });
    expect(
      oidcAssertion({ ...input, claims: { ...input.claims, email_verified: false } }),
    ).toMatchObject({ email: 'ada@example.com', emailVerified: false });
    expect(
      oidcAssertion({
        ...input,
        emailClaim: 'upn',
        claims: { ...input.claims, upn: 'admin@example.com' },
      }),
    ).toMatchObject({ email: 'admin@example.com', emailVerified: false });
  });
  it('refuses overage instead of deleting all sourced grants', () => {
    expect(() =>
      oidcAssertion({ ...input, claims: { ...input.claims, _claim_names: { groups: 'src1' } } }),
    ).toThrow('sso-groups-unavailable');
    expect(() => oidcAssertion({ ...input, claims: { ...input.claims, hasgroups: true } })).toThrow(
      'sso-groups-unavailable',
    );
  });
  it('rejects malformed and missing configured groups but permits an authoritative empty list', () => {
    expect(() => oidcAssertion({ ...input, claims: { ...input.claims, groups: [42] } })).toThrow();
    expect(() =>
      oidcAssertion({ ...input, claims: { ...input.claims, groups: undefined } }),
    ).toThrow('sso-groups-unavailable');
    expect(oidcAssertion({ ...input, claims: { ...input.claims, groups: [] } }).groups).toEqual([]);
  });
  it('compares browser nonce hashes and refuses missing or different cookies', () => {
    expect(matchesBrowserNonce('browser', ssoHash('browser'))).toBe(true);
    expect(matchesBrowserNonce(undefined, ssoHash('browser'))).toBe(false);
    expect(matchesBrowserNonce('wrong', ssoHash('browser'))).toBe(false);
  });
});

describe('SSO return paths', () => {
  it.each([
    '//evil.example',
    '/\\evil.example',
    '/%2f%2fevil.example',
    '/%5cevil.example',
    '/%00',
    'https://evil.example',
    '/%zz',
  ])('refuses hostile redirect target %s', (path) => {
    expect(ssoReturnToSchema.safeParse(path).success).toBe(false);
  });
  it('preserves a local path with Arabic and search parameters', () => {
    expect(ssoReturnToSchema.parse('/tickets?search=عُدي')).toBe('/tickets?search=عُدي');
    expect(ssoReturnToSchema.parse('/tickets?search=two%20words')).toBe(
      '/tickets?search=two%20words',
    );
  });
});

it('uses a host-prefixed HTTPS nonce cookie and a scoped local HTTP fallback', () => {
  const secure = oidcNonceCookie('https://support.example.com', 'connection');
  expect(secure).toMatchObject({
    name: '__Host-hd_sso_connection',
    attributes: { secure: true, httpOnly: true, path: '/', sameSite: 'lax' },
  });
  expect(secure.attributes).not.toHaveProperty('domain');
  expect(oidcNonceCookie('http://localhost:3100', 'connection')).toMatchObject({
    name: 'hd_sso_connection',
    attributes: { secure: false, path: '/api/auth/sso/connection' },
  });
});
