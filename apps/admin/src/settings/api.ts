import type {
  InstallAuthenticationSettings,
  InstallAuthenticationSettingsUpdate,
} from '@helpdock/schemas';

export interface SettingsApi {
  authentication(): Promise<InstallAuthenticationSettings>;
  saveAuthentication(
    request: InstallAuthenticationSettingsUpdate,
  ): Promise<InstallAuthenticationSettings>;
}

export const SETTINGS_AUTHENTICATION_QUERY_KEY = ['install', 'settings', 'authentication'] as const;
