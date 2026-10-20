import { describe, expect, it } from 'vitest';
import { MockSettingsApi } from './mock-api.js';

describe('MockSettingsApi', () => {
  it('keeps an omitted secret and enables a newly configured provider', async () => {
    const api = new MockSettingsApi();

    const updated = await api.saveAuthentication({
      requireTwoFactor: false,
      magicLinkValidityMinutes: 30,
      google: { clientId: 'updated-google-id' },
      microsoft: { clientId: '', tenantId: '' },
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

  it('turns Microsoft on only with a tenant, a client id and a secret', async () => {
    const api = new MockSettingsApi();
    const save = (tenantId: string) =>
      api.saveAuthentication({
        requireTwoFactor: false,
        magicLinkValidityMinutes: 30,
        google: { clientId: '' },
        microsoft: { clientId: 'ms-id', tenantId, clientSecret: 'ms-secret' },
        github: { clientId: '' },
      });

    expect((await save('')).microsoft).toMatchObject({
      clientSecretConfigured: true,
      enabled: false,
    });
    expect((await save('3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f')).microsoft).toMatchObject({
      tenantId: '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      enabled: true,
    });
  });
});
