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
      github: {
        clientId: '',
        clientIdLocked: false,
        clientSecretConfigured: false,
        clientSecretLocked: false,
        enabled: false,
      },
      redirectUrls: {
        google: 'https://support.example.com/api/auth/oauth/google/callback',
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
        github: { clientId: '', clientSecret: 'new-secret' },
      }).success,
    ).toBe(true);

    expect(
      installAuthenticationSettingsUpdateSchema.safeParse({
        requireTwoFactor: false,
        magicLinkValidityMinutes: 61,
        google: { clientId: '' },
        github: { clientId: '' },
      }).success,
    ).toBe(false);
  });
});

describe('the allowed Workspace domains', () => {
  const update = (allowedDomains: unknown) =>
    installAuthenticationSettingsUpdateSchema.safeParse({
      requireTwoFactor: false,
      magicLinkValidityMinutes: 10,
      google: { clientId: '', allowedDomains },
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
