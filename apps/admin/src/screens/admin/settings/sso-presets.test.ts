import type { SsoConnectionInput } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { applySsoPreset, hasIssuerPlaceholder } from './sso-presets.ts';

const oidc: Extract<SsoConnectionInput['config'], { protocol: 'oidc' }> = {
  protocol: 'oidc',
  issuer: 'https://idp.example.com',
  clientId: 'helpdock',
  scopes: ['openid', 'email'],
  emailClaim: 'mail',
  nameClaim: 'display',
  requireEmailVerified: true,
};

const draft: SsoConnectionInput = {
  name: 'Work',
  enabled: true,
  emailDomains: ['example.com'],
  jitEnabled: false,
  idpEnforcesMfa: true,
  defaultAccess: null,
  groupAttribute: 'roles',
  clientSecret: 'kept-secret',
  config: oidc,
};

describe('applySsoPreset', () => {
  it.each([
    ['google-workspace', 'https://accounts.google.com', null],
    ['entra-id', 'https://login.microsoftonline.com/{tenant-id}/v2.0', 'groups'],
    ['custom', '', null],
  ] as const)('%s overwrites the issuer, claims and groups claim', (preset, issuer, groups) => {
    const applied = applySsoPreset(draft, preset);
    expect(applied.config).toMatchObject({ issuer, emailClaim: 'email', nameClaim: 'name' });
    expect(applied.groupAttribute).toBe(groups);
  });

  it('keeps every field the preset does not own', () => {
    const { config, groupAttribute: _groups, ...rest } = applySsoPreset(draft, 'entra-id');
    const { config: _config, groupAttribute: _original, ...expected } = draft;
    expect(rest).toEqual(expected);
    expect(config).toMatchObject({
      clientId: oidc.clientId,
      scopes: oidc.scopes,
      requireEmailVerified: true,
    });
  });
});

describe('hasIssuerPlaceholder', () => {
  it('flags the Entra template until the tenant ID replaces it', () => {
    expect(hasIssuerPlaceholder(applySsoPreset(draft, 'entra-id'))).toBe(true);
    const tenantIssuer =
      'https://login.microsoftonline.com/0b6f6c1e-2f3c-4f63-9a7f-1d2c3b4a5e6f/v2.0';
    expect(hasIssuerPlaceholder({ ...draft, config: { ...oidc, issuer: tenantIssuer } })).toBe(
      false,
    );
  });
});
