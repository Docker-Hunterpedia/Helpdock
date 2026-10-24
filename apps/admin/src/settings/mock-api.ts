import type {
  InstallAuthenticationSettings,
  InstallAuthenticationSettingsUpdate,
  InstallPasskeys,
  InstallPasskeysMoved,
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

/** Where a browser test seeds the install's passkey status (`Partial<InstallPasskeys>`). */
export const MOCK_INSTALL_PASSKEYS_STORAGE = 'helpdock.mock.install-passkeys';

export const MOCK_INSTALL_PASSKEYS: InstallPasskeys = {
  state: 'available',
  rpId: 'localhost',
  pinnedRpId: 'localhost',
  pinnedAt: '2026-10-20T08:00:00.000Z',
  pinLocked: false,
  passkeyCount: 12,
  holderCount: 7,
  blockers: { breakGlassAccounts: 0, secondFactorAccounts: 0 },
};

const seededPasskeys = (): InstallPasskeys => {
  try {
    const raw = window.localStorage.getItem(MOCK_INSTALL_PASSKEYS_STORAGE);
    return {
      ...MOCK_INSTALL_PASSKEYS,
      ...(raw === null ? {} : (JSON.parse(raw) as Partial<InstallPasskeys>)),
    };
  } catch {
    return { ...MOCK_INSTALL_PASSKEYS };
  }
};

export class MockSettingsApi implements SettingsApi {
  #passkeys: InstallPasskeys = seededPasskeys();

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

  passkeys(): Promise<InstallPasskeys> {
    return Promise.resolve({ ...this.#passkeys });
  }

  movePasskeys(): Promise<InstallPasskeysMoved> {
    const removed = this.#passkeys.passkeyCount;
    const holders = this.#passkeys.holderCount;
    const rpId = this.#passkeys.rpId ?? '';
    this.#passkeys = {
      ...this.#passkeys,
      state: 'available',
      pinnedRpId: rpId,
      pinnedAt: new Date().toISOString(),
      passkeyCount: 0,
      holderCount: 0,
    };
    return Promise.resolve({ rpId, passkeysRemoved: removed, holdersNotified: holders });
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
