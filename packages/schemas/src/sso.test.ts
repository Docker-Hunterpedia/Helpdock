import { describe, expect, it } from 'vitest';
import {
  ssoConfigurationSchema,
  ssoConnectionConfigSchema,
  ssoConnectionCreateSchema,
  ssoConnectionSchema,
  ssoMappingSchema,
  ssoMappingsSchema,
  ssoSettingsUpdateSchema,
} from './sso.js';

const oidc = {
  name: 'Work',
  config: { protocol: 'oidc', issuer: 'https://idp.example.com', clientId: 'client' },
};

describe('SSO configuration boundaries', () => {
  it.each([
    'https://user:password@idp.example.com',
    'file:///etc/passwd',
    '',
    'not-a-url',
    'https://idp.example.com/#secret',
    'https://login.microsoftonline.com/{tenant-id}/v2.0',
  ])('refuses an unsafe or unfinished identity endpoint %s', (issuer) => {
    expect(
      ssoConnectionCreateSchema.safeParse({ ...oidc, config: { ...oidc.config, issuer } }).success,
    ).toBe(false);
  });
  it('still reads a stored issuer that holds the template placeholder', () => {
    const issuer = 'https://login.microsoftonline.com/{tenant-id}/v2.0';
    expect(ssoConnectionConfigSchema.parse({ ...oidc.config, issuer })).toMatchObject({ issuer });
  });
  it('requires OIDC identity scope and verified email', () => {
    for (const override of [{ scopes: ['profile'] }, { requireEmailVerified: false }]) {
      expect(
        ssoConnectionCreateSchema.safeParse({ ...oidc, config: { ...oidc.config, ...override } })
          .success,
      ).toBe(false);
    }
  });
  it('normalizes discovery domains and rejects wildcards', () => {
    expect(
      ssoConnectionCreateSchema.parse({ ...oidc, emailDomains: [' EXAMPLE.COM '] }).emailDomains,
    ).toEqual(['example.com']);
    expect(
      ssoConnectionCreateSchema.safeParse({ ...oidc, emailDomains: ['*.example.com'] }).success,
    ).toBe(false);
  });
  it('does not expose protocol secrets or persistence fields in a connection', () => {
    const connection = ssoConnectionCreateSchema.parse(oidc);
    const response = ssoConnectionSchema.parse({
      ...connection,
      id: '00000000-0000-4000-8000-000000000001',
      protocol: 'oidc',
      secretConfigured: true,
      clientSecret: 'not-on-the-wire',
      secretEncrypted: 'not-on-the-wire',
      lastSignInAt: null,
      createdAt: '2026-10-13T00:00:00Z',
      updatedAt: '2026-10-13T00:00:00Z',
    });
    expect(JSON.stringify(response)).not.toContain('not-on-the-wire');
  });
  it('cannot grant an agent unrestricted departments', () => {
    expect(
      ssoMappingSchema.safeParse({
        brandId: '00000000-0000-4000-8000-000000000001',
        idpGroup: 'support',
        position: 0,
        role: 'agent',
        departmentIds: null,
      }).success,
    ).toBe(false);
  });
  it('requires a break-glass identity when enabling enforcement', () => {
    expect(
      ssoSettingsUpdateSchema.safeParse({ enforced: true, breakGlassUserIds: [] }).success,
    ).toBe(false);
  });
  it('refuses ambiguous first-match priority within a brand', () => {
    const mapping = {
      brandId: '00000000-0000-4000-8000-000000000001',
      role: 'admin',
      departmentIds: null,
      position: 0,
    };
    expect(
      ssoMappingsSchema.safeParse({
        mappings: [
          { ...mapping, idpGroup: 'first' },
          { ...mapping, idpGroup: 'second' },
        ],
      }).success,
    ).toBe(false);
  });
});

it('preserves mapping priority validation when saving a whole configuration', () => {
  const mapping = {
    idpGroup: 'Support',
    brandId: '00000000-0000-4000-8000-000000000001',
    role: 'viewer',
    departmentIds: null,
    position: 0,
  };
  expect(
    ssoConfigurationSchema.safeParse({
      connection: oidc,
      mappings: [mapping, { ...mapping, idpGroup: 'Leads' }],
    }).success,
  ).toBe(false);
});
