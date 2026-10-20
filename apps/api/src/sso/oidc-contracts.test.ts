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
  issuer: 'https://idp.example.com',
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

describe('Entra ID email verification by xms_edov (M18-09)', () => {
  const tenant = '0b6f6c1e-2f3c-4f63-9a7f-1d2c3b4a5e6f';
  const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
  const entra = {
    ...input,
    issuer,
    claims: {
      sub: 'entra-subject',
      iss: issuer,
      tid: tenant,
      email: 'ada@example.com',
      xms_edov: true,
      name: 'Ada',
      groups: ['Support'],
    },
  };
  const consumer = 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0';

  it('vouches for the email claim when a GUID-tenant issuer, its tid and xms_edov agree', () => {
    expect(oidcAssertion(entra)).toMatchObject({ email: 'ada@example.com', emailVerified: true });
  });

  it.each([
    ['xms_edov is missing', { claims: { ...entra.claims, xms_edov: undefined } }],
    ['xms_edov is false', { claims: { ...entra.claims, xms_edov: false } }],
    ['xms_edov is a string', { claims: { ...entra.claims, xms_edov: 'true' } }],
    ['the token names another tenant', { claims: { ...entra.claims, tid: uuidv7() } }],
    [
      'the token has another issuer',
      { claims: { ...entra.claims, iss: 'https://idp.example.com' } },
    ],
    ...['common', 'organizations', 'consumers'].map(
      (alias) =>
        [
          `the issuer is the ${alias} endpoint`,
          {
            issuer: `https://login.microsoftonline.com/${alias}/v2.0`,
            claims: {
              ...entra.claims,
              iss: `https://login.microsoftonline.com/${alias}/v2.0`,
              tid: alias,
            },
          },
        ] as const,
    ),
    [
      'the issuer is the personal-account tenant',
      {
        issuer: consumer,
        claims: { ...entra.claims, iss: consumer, tid: '9188040d-6c67-4c5b-b112-36a304b66dad' },
      },
    ],
    ['the issuer is not Entra', { issuer: 'https://idp.example.com' }],
    [
      'the email comes from another claim',
      { emailClaim: 'upn', claims: { ...entra.claims, upn: 'ada@example.com' } },
    ],
  ] as const)('refuses the address when %s', (_case, overrides) => {
    expect(oidcAssertion({ ...entra, ...overrides }).emailVerified).toBe(false);
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
