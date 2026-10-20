import { describe, expect, it } from 'vitest';
import { decideOauthSignIn, googleDomainAllowed, googleIsAuthoritative } from './oauth-linking.js';

describe('googleIsAuthoritative', () => {
  it.each([
    ['a Workspace account whose hd is the address domain', 'lina@acme.com', true, 'acme.com', true],
    ['a Workspace hd in another case', 'lina@Acme.com', true, 'ACME.com', true],
    ['a consumer Gmail address', 'lina@gmail.com', true, undefined, true],
    ['a consumer Googlemail address', 'lina@googlemail.com', true, undefined, true],
    ['a consumer account on a third-party address', 'lina@acme.com', true, undefined, false],
    ['a Workspace hd that is not the address domain', 'lina@acme.com', true, 'other.com', false],
    ['an unverified Gmail address', 'lina@gmail.com', false, undefined, false],
  ] as const)('decides %s', (_case, email, emailVerified, hostedDomain, expected) => {
    expect(googleIsAuthoritative({ email, emailVerified, hostedDomain })).toBe(expected);
  });
});

describe('googleDomainAllowed (oauth.google.allowedDomains)', () => {
  it.each([
    ['any account when the list is empty', undefined, [], true],
    ['a Workspace account on a listed domain', 'acme.com', ['acme.com', 'acme.sa'], true],
    ['a listed domain Google sends in another case', 'ACME.sa', ['acme.com', 'acme.sa'], true],
    ['a Workspace account on another domain', 'other.com', ['acme.com'], false],
    ['a consumer account, which has no hd', undefined, ['acme.com'], false],
  ] as const)('allows %s: %s', (_case, hostedDomain, allowedDomains, expected) => {
    expect(googleDomainAllowed({ hostedDomain, allowedDomains })).toBe(expected);
  });
});

describe('decideOauthSignIn', () => {
  const lina = { userId: 'lina', hasProviderIdentity: false };

  it('signs in the account a subject is bound to, whatever the address says now', () => {
    expect(
      decideOauthSignIn({ linkedUserId: 'lina', authoritative: false, emailMatch: undefined }),
    ).toEqual({ kind: 'sign-in', userId: 'lina', link: false });
  });

  it('makes the first link by address only where the provider controls the address', () => {
    expect(
      decideOauthSignIn({ linkedUserId: undefined, authoritative: true, emailMatch: lina }),
    ).toEqual({ kind: 'sign-in', userId: 'lina', link: true });
  });

  it('asks for a connection from a session when the provider does not control the address', () => {
    expect(
      decideOauthSignIn({ linkedUserId: undefined, authoritative: false, emailMatch: lina }),
    ).toEqual({
      kind: 'refuse',
      code: 'oauth-link-required',
      userId: null,
      reason: 'link-required',
    });
  });

  it('answers a non-authoritative stranger the same way, so the answer names nobody', () => {
    expect(
      decideOauthSignIn({ linkedUserId: undefined, authoritative: false, emailMatch: undefined }),
    ).toEqual(
      decideOauthSignIn({ linkedUserId: undefined, authoritative: false, emailMatch: lina }),
    );
  });

  it('refuses an authoritative address nobody here holds', () => {
    expect(
      decideOauthSignIn({ linkedUserId: undefined, authoritative: true, emailMatch: undefined }),
    ).toEqual({ kind: 'refuse', code: 'no-account', userId: null, reason: 'unknown-account' });
  });

  it('never moves an account that is already bound to another account of the provider', () => {
    expect(
      decideOauthSignIn({
        linkedUserId: undefined,
        authoritative: true,
        emailMatch: { userId: 'lina', hasProviderIdentity: true },
      }),
    ).toEqual({
      kind: 'refuse',
      code: 'oauth-identity-conflict',
      userId: 'lina',
      reason: 'identity-conflict',
    });
  });
});
