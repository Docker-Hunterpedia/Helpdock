import {
  type InstallAuthenticationSettings,
  type InstallAuthenticationSettingsUpdate,
  installAuthenticationSettingsSchema,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import type { SettingsApi } from './api.js';

const AUTHENTICATION = '/install/settings/authentication';

export class HttpSettingsApi implements SettingsApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async authentication(): Promise<InstallAuthenticationSettings> {
    return installAuthenticationSettingsSchema.parse(
      await this.#transport.request('GET', AUTHENTICATION),
    );
  }

  async saveAuthentication(
    request: InstallAuthenticationSettingsUpdate,
  ): Promise<InstallAuthenticationSettings> {
    return installAuthenticationSettingsSchema.parse(
      await this.#transport.request('PUT', AUTHENTICATION, request),
    );
  }
}
