import type {
  InstallAuthenticationSettings,
  InstallAuthenticationSettingsUpdate,
} from '@helpdock/schemas';
import type { SettingsApi } from './api.js';

export const MOCK_AUTHENTICATION_SETTINGS: InstallAuthenticationSettings = {
  requireTwoFactor: true,
  requireTwoFactorLocked: false,
  magicLinkValidityMinutes: 10,
  magicLinkValidityLocked: false,
  google: {
    clientId: '8123.apps.googleusercontent.com',
    clientIdLocked: true,
    clientSecretConfigured: true,
    clientSecretLocked: false,
    enabled: true,
    allowedDomains: [],
    allowedDomainsLocked: false,
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
    google: 'http://localhost:5273/api/auth/oauth/google/callback',
    microsoft: 'http://localhost:5273/api/auth/oauth/microsoft/callback',
    github: 'http://localhost:5273/api/auth/oauth/github/callback',
  },
};

export class MockSettingsApi implements SettingsApi {
  #authentication: InstallAuthenticationSettings = structuredClone(MOCK_AUTHENTICATION_SETTINGS);

  authentication(): Promise<InstallAuthenticationSettings> {
    return Promise.resolve(structuredClone(this.#authentication));
  }

  saveAuthentication(
    request: InstallAuthenticationSettingsUpdate,
  ): Promise<InstallAuthenticationSettings> {
    this.#authentication = {
      ...this.#authentication,
      requireTwoFactor: request.requireTwoFactor,
      magicLinkValidityMinutes: request.magicLinkValidityMinutes,
      google: {
        ...updatedProvider(this.#authentication.google, request.google),
        allowedDomains: request.google.allowedDomains ?? this.#authentication.google.allowedDomains,
      },
      microsoft: {
        ...updatedProvider(this.#authentication.microsoft, request.microsoft),
        tenantId: request.microsoft.tenantId,
        allowConsumers:
          request.microsoft.allowConsumers ?? this.#authentication.microsoft.allowConsumers,
        // Off without a tenant, as the api reports it.
        enabled:
          updatedProvider(this.#authentication.microsoft, request.microsoft).enabled &&
          request.microsoft.tenantId !== '',
      },
      github: updatedProvider(this.#authentication.github, request.github),
    };

    return this.authentication();
  }
}

const updatedProvider = <TProvider extends InstallAuthenticationSettings['github']>(
  current: TProvider,
  update: InstallAuthenticationSettingsUpdate['github'],
): TProvider => {
  const clientSecretConfigured =
    update.clientSecret === undefined ? current.clientSecretConfigured : true;

  return {
    ...current,
    clientId: update.clientId,
    clientSecretConfigured,
    enabled: update.clientId !== '' && clientSecretConfigured,
  };
};
