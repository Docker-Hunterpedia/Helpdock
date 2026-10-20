import { describe, expect, it } from 'vitest';
import {
  installAuthenticationSettingsSchema,
  installAuthenticationSettingsUpdateSchema,
  workspaceDomainSchema,
} from './install-settings.js';

describe('install authentication settings', () => {
  it('refuses a response shape that contains a secret value', () => {
    const result = installAuthenticationSettingsSchema.safeParse({
      requireTwoFactor: true,
      requireTwoFactorLocked: false,
      magicLinkValidityMinutes: 10,
      magicLinkValidityLocked: false,
      google: {
        clientId: 'google-id',
        clientIdLocked: false,
        clientSecretConfigured: true,
        clientSecretLocked: false,
        enabled: true,
        allowedDomains: [],
        allowedDomainsLocked: false,
        clientSecret: 'must-not-leak',
      },
      microsoft: {
        clientId: '',
        clientIdLocked: false,
        clientSecretConfigured: false,
        clientSecretLocked: false,
        enabled: false,
        tenantId: '',
        tenantIdLocked: false,
        allowConsumers: false,
        allowConsumersLocked: false,
      },
      github: {
        clientId: '',
        clientIdLocked: false,
        clientSecretConfigured: false,
        clientSecretLocked: false,
        enabled: false,
      },
      redirectUrls: {
        google: 'https://support.example.com/api/auth/oauth/google/callback',
        microsoft: 'https://support.example.com/api/auth/oauth/microsoft/callback',
        github: 'https://support.example.com/api/auth/oauth/github/callback',
      },
    });

    expect(result.success).toBe(false);
  });

  it('accepts an omitted secret as keep-existing and validates the link lifetime', () => {
    expect(
      installAuthenticationSettingsUpdateSchema.safeParse({
        requireTwoFactor: false,
        magicLinkValidityMinutes: 10,
        google: { clientId: 'google-id' },
        microsoft: { clientId: '', tenantId: '' },
        github: { clientId: '', clientSecret: 'new-secret' },
      }).success,
    ).toBe(true);

    expect(
      installAuthenticationSettingsUpdateSchema.safeParse({
        requireTwoFactor: false,
        magicLinkValidityMinutes: 61,
        google: { clientId: '' },
        microsoft: { clientId: '', tenantId: '' },
        github: { clientId: '' },
      }).success,
    ).toBe(false);
  });
});

describe('the Microsoft tenant', () => {
  const update = (tenantId: unknown) =>
    installAuthenticationSettingsUpdateSchema.safeParse({
      requireTwoFactor: false,
      magicLinkValidityMinutes: 10,
      google: { clientId: '' },
      microsoft: { clientId: 'app-id', tenantId },
      github: { clientId: '' },
    });
  const GUID = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

  it('takes a GUID, trimmed and lower-cased, or empty to turn the provider off', () => {
    const parsed = update(` ${GUID.toUpperCase()} `);

    expect(parsed.success && parsed.data.microsoft.tenantId).toBe(GUID);
    expect(update('').success).toBe(true);
  });

  it.each([
    ['common'],
    ['organizations'],
    ['consumers'],
    ['contoso.onmicrosoft.com'],
    [`${GUID}0`],
    ['9188040d-6c67-4c5b-b112-36a304b66dad'],
  ])('refuses %s, which is not one work tenant', (tenantId) => {
    expect(update(tenantId).success).toBe(false);
  });
});

describe('the allowed Workspace domains', () => {
  const update = (allowedDomains: unknown) =>
    installAuthenticationSettingsUpdateSchema.safeParse({
      requireTwoFactor: false,
      magicLinkValidityMinutes: 10,
      google: { clientId: '', allowedDomains },
      microsoft: { clientId: '', tenantId: '' },
      github: { clientId: '' },
    });

  it('lower-cases, trims and de-duplicates the domains it is given', () => {
    const parsed = update([' Helpdock.com ', 'helpdock.com', 'helpdock.sa']);

    expect(parsed.success && parsed.data.google.allowedDomains).toEqual([
      'helpdock.com',
      'helpdock.sa',
    ]);
  });

  it.each([['@gmail.com'], ['lina@helpdock.com'], ['localhost'], ['https://helpdock.com']])(
    'refuses %s, which is not a domain',
    (domain) => {
      expect(update([domain]).success).toBe(false);
    },
  );

  it.each([['gmail.com'], ['GoogleMail.com']])(
    'refuses the consumer domain %s with a message saying why',
    (domain) => {
      const parsed = update([domain]);

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toMatch(/not Workspace domains/);
    },
  );

  it('refuses more than twenty domains', () => {
    expect(update(Array.from({ length: 21 }, (_, index) => `d${index}.example.com`)).success).toBe(
      false,
    );
  });

  it('accepts a domain the setting stores', () => {
    expect(workspaceDomainSchema.parse('acme.co.uk')).toBe('acme.co.uk');
  });
});
