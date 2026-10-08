import { describe, expect, it } from 'vitest';
import {
  installAuthenticationSettingsSchema,
  installAuthenticationSettingsUpdateSchema,
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
