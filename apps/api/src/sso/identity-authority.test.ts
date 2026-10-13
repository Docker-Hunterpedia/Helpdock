import { describe, expect, it } from 'vitest';
import { ssoIdentityAuthority } from './identity-authority.js';

describe('SSO identity authority', () => {
  const config = { protocol: 'oidc', issuer: 'https://idp.example.com', clientId: 'client' };
  it('ignores serialization order and non-identity claim settings', () => {
    expect(ssoIdentityAuthority(config)).toBe(
      ssoIdentityAuthority({
        clientId: 'client',
        issuer: config.issuer,
        protocol: 'oidc',
        nameClaim: 'display_name',
      }),
    );
  });
  it.each([{ issuer: 'https://other.example.com' }, { clientId: 'other-client' }])(
    'separates accounts when the identity authority changes',
    (change) => {
      expect(ssoIdentityAuthority(config)).not.toBe(ssoIdentityAuthority({ ...config, ...change }));
    },
  );
});
