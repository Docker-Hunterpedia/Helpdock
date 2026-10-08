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
      google: updatedProvider(this.#authentication.google, request.google),
      github: updatedProvider(this.#authentication.github, request.github),
    };

    return this.authentication();
  }
}

const updatedProvider = (
  current: InstallAuthenticationSettings['google'],
  update: InstallAuthenticationSettingsUpdate['google'],
): InstallAuthenticationSettings['google'] => {
  const clientSecretConfigured =
    update.clientSecret === undefined ? current.clientSecretConfigured : true;

  return {
    ...current,
    clientId: update.clientId,
    clientSecretConfigured,
    enabled: update.clientId !== '' && clientSecretConfigured,
  };
};
