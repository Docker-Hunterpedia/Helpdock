import {
  type InstallAuthenticationSettings,
  type InstallAuthenticationSettingsUpdate,
  type InstallPasskeys,
  type InstallPasskeysMoved,
  installAuthenticationSettingsSchema,
  installPasskeysMovedSchema,
  installPasskeysSchema,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import type { SettingsApi } from './api.js';

const AUTHENTICATION = '/install/settings/authentication';
const PASSKEYS = '/install/passkeys';

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

  async passkeys(): Promise<InstallPasskeys> {
    return installPasskeysSchema.parse(await this.#transport.request('GET', PASSKEYS));
  }

  async movePasskeys(): Promise<InstallPasskeysMoved> {
    return installPasskeysMovedSchema.parse(
      await this.#transport.request('POST', `${PASSKEYS}/move`),
    );
  }
}
