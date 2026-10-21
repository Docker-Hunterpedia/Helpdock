import type {
  InstallAuthenticationSettings,
  InstallAuthenticationSettingsUpdate,
  InstallPasskeys,
  InstallPasskeysMoved,
} from '@helpdock/schemas';

export interface SettingsApi {
  authentication(): Promise<InstallAuthenticationSettings>;
  saveAuthentication(
    request: InstallAuthenticationSettingsUpdate,
  ): Promise<InstallAuthenticationSettings>;
  /** Whether passkeys work on this install, the RP ID they were made for, and how many exist. */
  passkeys(): Promise<InstallPasskeys>;
  /** Removes every passkey and pins the RP ID to the current address; holders are emailed. */
  movePasskeys(): Promise<InstallPasskeysMoved>;
}

export const SETTINGS_AUTHENTICATION_QUERY_KEY = ['install', 'settings', 'authentication'] as const;
export const SETTINGS_PASSKEYS_QUERY_KEY = ['install', 'passkeys'] as const;
