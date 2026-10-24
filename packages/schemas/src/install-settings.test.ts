import { describe, expect, it } from 'vitest';
import {
  installAuthenticationSettingsSchema,
  installAuthenticationSettingsUpdateSchema,
  smtpSettingsSchema,
  smtpSettingsUpdateSchema,
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

describe('the outgoing email settings (#369)', () => {
  const read = {
    configured: true,
    host: 'smtp.example.com',
    port: 587,
    tls: 'starttls',
    user: 'postmaster',
    passwordConfigured: true,
    fromAddress: 'no-reply@example.com',
    fromName: 'Example',
    locked: {
      host: false,
      port: false,
      tls: false,
      user: false,
      password: false,
      fromAddress: false,
      fromName: false,
    },
  } as const;

  it('accepts the shape the api answers with, and carries no password', () => {
    expect(smtpSettingsSchema.parse(read)).toEqual(read);
    expect('password' in smtpSettingsSchema.parse(read)).toBe(false);
  });

  it('accepts an unconfigured install, whose From address is still empty', () => {
    expect(
      smtpSettingsSchema.safeParse({
        ...read,
        configured: false,
        host: '',
        user: '',
        passwordConfigured: false,
        fromAddress: '',
        fromName: '',
      }).success,
    ).toBe(true);
  });

  it('refuses a port no server has', () => {
    expect(smtpSettingsSchema.safeParse({ ...read, port: 0 }).success).toBe(false);
    expect(smtpSettingsSchema.safeParse({ ...read, port: 65_536 }).success).toBe(false);
  });

  it('refuses a TLS mode the wizard never offered', () => {
    expect(smtpSettingsSchema.safeParse({ ...read, tls: 'ssl' }).success).toBe(false);
  });

  it('keeps a save honest about its shape', () => {
    expect(
      smtpSettingsUpdateSchema.parse({
        host: ' smtp.example.com ',
        port: 465,
        tls: 'tls',
        user: '',
        fromAddress: 'no-reply@example.com',
        fromName: ' Example ',
      }),
    ).toEqual({
      host: 'smtp.example.com',
      port: 465,
      tls: 'tls',
      user: '',
      fromAddress: 'no-reply@example.com',
      fromName: 'Example',
    });
  });

  it('lets the password stay behind, and refuses an empty one in its place', () => {
    const body = {
      host: 'smtp.example.com',
      port: 587,
      tls: 'starttls',
      user: '',
      fromAddress: 'no-reply@example.com',
      fromName: 'Example',
    };
    expect(smtpSettingsUpdateSchema.safeParse(body).success).toBe(true);
    expect(smtpSettingsUpdateSchema.safeParse({ ...body, password: '' }).success).toBe(false);
    expect(smtpSettingsUpdateSchema.safeParse({ ...body, password: 'relay-secret' }).success).toBe(
      true,
    );
  });

  it('refuses a save without a host, a From address or a name', () => {
    const body = {
      host: 'smtp.example.com',
      port: 587,
      tls: 'starttls',
      user: '',
      fromAddress: 'no-reply@example.com',
      fromName: 'Example',
    };
    for (const key of ['host', 'fromAddress', 'fromName'] as const) {
      expect(
        smtpSettingsUpdateSchema.safeParse({ ...body, [key]: key === 'host' ? '' : ' ' }).success,
        key,
      ).toBe(false);
    }
  });
});
