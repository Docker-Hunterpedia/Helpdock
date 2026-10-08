import { describe, expect, it } from 'vitest';
import { MockSettingsApi } from './mock-api.js';

describe('MockSettingsApi', () => {
  it('keeps an omitted secret and enables a newly configured provider', async () => {
    const api = new MockSettingsApi();

    const updated = await api.saveAuthentication({
      requireTwoFactor: false,
      magicLinkValidityMinutes: 30,
      google: { clientId: 'updated-google-id' },
      github: { clientId: 'github-id', clientSecret: 'github-secret' },
    });

    expect(updated.google).toMatchObject({
      clientId: 'updated-google-id',
      clientSecretConfigured: true,
      enabled: true,
    });
    expect(updated.github).toMatchObject({
      clientId: 'github-id',
      clientSecretConfigured: true,
      enabled: true,
    });
    expect(updated).not.toHaveProperty('google.clientSecret');
  });
});
